import {
  EVAL_ATTRIBUTION_HEADER,
  EVAL_POLICY_BYPASS_HEADER
} from "@velum-labs/routekit-eval-contracts";
import {
  EVAL_AUTHORING_REQUEST_BYTES,
  type EvalAuthoringCompletion,
  EvalAuthoringTransport,
  EvalProjectAuthoringError
} from "@velum-labs/routekit-eval-setup";
import { trimTrailingSlashes } from "@velum-labs/routekit-runtime/network";
import { executeWebRequest, RouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Context, Effect, Layer, Redacted } from "effect";
import type { HttpClient } from "effect/unstable/http";

import { cliTry } from "../cli-session.js";
import { routekitClient } from "../client.js";
import { selectedRemoteMetadata } from "../target.js";

type AuthoringSession = {
  readonly sessionId: string;
  readonly gatewayUrl: string;
  readonly bearerCredential: Redacted.Redacted<string>;
};

const AUTHORING_FAILURE_BODY_BYTES = 16 * 1024;
const MODEL_CALL_ID_HEADER = "x-routekit-model-call-id";

export const evalSessionGatewayUrl = (
  openedGatewayUrl: string,
  selectedRemoteGatewayUrl?: string
): string => selectedRemoteGatewayUrl ?? openedGatewayUrl;

const authoringFailure = (
  operation: EvalProjectAuthoringError["operation"],
  detail: string,
  cause?: unknown
): EvalProjectAuthoringError =>
  new EvalProjectAuthoringError({
    operation,
    detail,
    ...(cause === undefined ? {} : { cause })
  });

const outputText = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const root = payload as { output_text?: unknown; output?: unknown };
  if (typeof root.output_text === "string" && root.output_text.trim().length > 0) {
    return root.output_text.trim();
  }
  if (!Array.isArray(root.output)) return undefined;
  const text = root.output
    .flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "output_text" &&
        typeof (part as { text?: unknown }).text === "string"
          ? [(part as { text: string }).text]
          : []
      );
    })
    .join("")
    .trim();
  return text.length === 0 ? undefined : text;
};

export const evalAuthoringRequestBody = (input: EvalAuthoringCompletion): string =>
  JSON.stringify({
    model: input.model,
    instructions: input.instructions,
    input: input.input,
    text: {
      format: {
        type: "json_schema",
        name: input.schemaName,
        schema: input.jsonSchema,
        strict: true
      }
    },
    // Do not force `reasoning.effort: "none"`. `none` is not a portable
    // effort value and healthy catalog models can reject it before provider I/O.
    max_output_tokens: input.maximumOutputTokens
  });

const readAuthoringFailureBody = async (
  response: Response
): Promise<{ readonly text: string; readonly truncated: boolean }> => {
  if (response.body === null) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = AUTHORING_FAILURE_BODY_BYTES - bytes;
      if (remaining <= 0) {
        await reader.cancel().catch(() => undefined);
        return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
      }
      const chunk =
        next.value.byteLength > remaining ? next.value.subarray(0, remaining) : next.value;
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (chunk.byteLength < next.value.byteLength) {
        await reader.cancel().catch(() => undefined);
        return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
      }
    }
    return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
  } finally {
    reader.releaseLock();
  }
};

const upstreamErrorMetadata = (
  body: string
): { readonly code?: string; readonly param?: string } => {
  try {
    const payload = JSON.parse(body) as { error?: unknown };
    if (typeof payload.error !== "object" || payload.error === null) return {};
    const error = payload.error as { code?: unknown; param?: unknown };
    return {
      ...(typeof error.code === "string" && error.code.length > 0 ? { code: error.code } : {}),
      ...(typeof error.param === "string" && error.param.length > 0 ? { param: error.param } : {})
    };
  } catch {
    return {};
  }
};

export const evalAuthoringResponseFailureDetail = (response: Response): Effect.Effect<string> =>
  Effect.promise(async () => {
    const body = await readAuthoringFailureBody(response).catch(() => ({
      text: "",
      truncated: false
    }));
    const text = body.text.trim();
    const metadata = upstreamErrorMetadata(text);
    const callId = response.headers.get(MODEL_CALL_ID_HEADER);
    return [
      response.status >= 300 && response.status < 400
        ? "author model request was redirected and rejected"
        : `author model request failed with HTTP ${String(response.status)}`,
      ...(metadata.code === undefined ? [] : [`code ${metadata.code}`]),
      ...(metadata.param === undefined ? [] : [`param ${metadata.param}`]),
      ...(callId === null || callId.length === 0 ? ["call id unavailable"] : [`call id ${callId}`]),
      `upstream body ${text.length === 0 ? "<empty>" : text}${body.truncated ? "… (truncated)" : ""}`
    ].join("; ");
  });

function targetAuthoringTransport(
  session: AuthoringSession,
  httpContext: Context.Context<HttpClient.HttpClient>
) {
  const complete = (input: EvalAuthoringCompletion) =>
    Effect.gen(function* () {
      const operation =
        input.schemaName === "routekit_routing_basis"
          ? ("authoring-dimensions" as const)
          : ("authoring-evaluations" as const);
      const body = evalAuthoringRequestBody(input);
      if (Buffer.byteLength(body) > EVAL_AUTHORING_REQUEST_BYTES) {
        return yield* authoringFailure(
          operation,
          "author model request exceeds the bounded authoring input allowance"
        );
      }
      const response = yield* executeWebRequest(
        `${trimTrailingSlashes(session.gatewayUrl)}/v1/responses`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            authorization: `Bearer ${Redacted.value(session.bearerCredential)}`,
            "content-type": "application/json",
            [EVAL_POLICY_BYPASS_HEADER]: "1",
            [EVAL_ATTRIBUTION_HEADER]: JSON.stringify({
              purpose: "eval",
              role: "author",
              runId: input.operationId
            })
          },
          body
        }
      ).pipe(
        Effect.mapError((cause) =>
          authoringFailure(operation, "author model request failed", cause)
        )
      );
      if (response.status < 200 || response.status >= 300) {
        const detail = yield* evalAuthoringResponseFailureDetail(response);
        return yield* authoringFailure(operation, detail);
      }
      const payload = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) =>
          authoringFailure(operation, "author model returned invalid response JSON", cause)
      });
      const text = outputText(payload);
      if (text === undefined || text.length > 512_000) {
        return yield* authoringFailure(
          operation,
          "author model returned no bounded structured output"
        );
      }
      return text;
    }).pipe(Effect.provide(httpContext));
  return EvalAuthoringTransport.of({ complete });
}

export function withTargetAuthoringSession<A, E, R>(input: {
  readonly operationId: string;
  readonly model: string;
  readonly calls: number;
  readonly maximumOutputTokens: number;
  readonly use: (layer: Layer.Layer<EvalAuthoringTransport>) => Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | Error, R | HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const remote = yield* cliTry(() => selectedRemoteMetadata());
    const client = yield* routekitClient;
    const httpContext = yield* Effect.context<HttpClient.HttpClient>();
    yield* client.call("models.info", { model: input.model });
    return yield* Effect.acquireUseRelease(
      client
        .call(
          "evalSession.open",
          {
            purpose: "authoring",
            operationId: input.operationId,
            allowedModels: [input.model],
            limits: {
              calls: input.calls,
              inputTokens: input.calls * EVAL_AUTHORING_REQUEST_BYTES,
              outputTokens: input.calls * input.maximumOutputTokens,
              perCallOutputTokens: input.maximumOutputTokens,
              wallTimeMs: 30 * 60_000
            },
            expiresInSeconds: 30 * 60
          },
          { idempotencyKey: input.operationId }
        )
        .pipe(
          Effect.map((opened) => ({
            sessionId: opened.sessionId,
            gatewayUrl: evalSessionGatewayUrl(opened.gatewayUrl, remote?.gatewayUrl),
            bearerCredential: Redacted.make(opened.bearerCredential)
          }))
        ),
      (session) =>
        input.use(
          Layer.succeed(EvalAuthoringTransport, targetAuthoringTransport(session, httpContext))
        ),
      (session) =>
        client
          .call(
            "evalSession.close",
            { sessionId: session.sessionId },
            { idempotencyKey: `close-${input.operationId}` }
          )
          .pipe(
            Effect.flatMap((result) =>
              result.closed
                ? Effect.void
                : Effect.fail(
                    new RouteKitFailure({
                      message: "RouteKit eval authoring session cleanup was not confirmed"
                    })
                  )
            )
          )
    );
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof EvalProjectAuthoringError || cause instanceof RouteKitFailure
        ? cause
        : new RouteKitFailure({ message: "RouteKit eval authoring target failed", cause })
    )
  ) as Effect.Effect<A, E | Error, R | HttpClient.HttpClient>;
}
