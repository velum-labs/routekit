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
import { executeWebRequest, RouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { trimTrailingSlashes } from "@velum-labs/routekit-runtime/network";
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
const AUTHORING_OUTPUT_BYTES = 512_000;
const AUTHORING_OUTPUT_DIAGNOSTIC_BYTES = 16 * 1024;
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

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const wrapperValues = (value: unknown, schemaName: string, depth = 0): unknown[] => {
  if (depth > 4) return [];
  const record = recordOf(value);
  if (record === undefined) return [];
  const values: unknown[] = [];
  if (Object.hasOwn(record, schemaName)) values.push(record[schemaName]);
  if (record.name === schemaName) {
    if (Object.hasOwn(record, "arguments")) values.push(record.arguments);
    if (Object.hasOwn(record, "input")) values.push(record.input);
  }
  if (recordOf(record.function)?.name === schemaName) {
    values.push(recordOf(record.function)?.arguments);
  }
  for (const field of ["tool_calls", "output", "content"] as const) {
    if (Array.isArray(record[field])) {
      for (const nested of record[field]) {
        values.push(...wrapperValues(nested, schemaName, depth + 1));
      }
    }
  }
  return values.filter((candidate) => candidate !== undefined);
};

const outputText = (payload: unknown, schemaName: string): string | undefined => {
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
  if (text.length > 0) return text;
  for (const value of wrapperValues(payload, schemaName)) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (recordOf(value) !== undefined || Array.isArray(value)) return JSON.stringify(value);
  }
  return undefined;
};

const balancedJsonCandidates = (text: string): string[] => {
  const candidates: string[] = [];
  const closers: string[] = [];
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char === "{" || char === "[") {
        start = index;
        closers.push(char === "{" ? "}" : "]");
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "{" || char === "[") {
      closers.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char !== "}" && char !== "]") continue;
    if (closers.at(-1) !== char) {
      start = -1;
      closers.length = 0;
      continue;
    }
    closers.pop();
    if (closers.length === 0) {
      candidates.push(text.slice(start, index + 1));
      start = -1;
    }
  }
  return candidates;
};

const jsonCandidates = (text: string): string[] => {
  const trimmed = text.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) {
    if (match[1] !== undefined) candidates.push(match[1].trim());
  }
  candidates.push(...balancedJsonCandidates(trimmed));
  return [...new Set(candidates.filter((candidate) => candidate.length > 0))];
};

const parseWrappedValue = (value: unknown): unknown | undefined => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

const matchesSchemaRoot = (
  value: unknown,
  jsonSchema: Readonly<Record<string, unknown>>
): boolean => {
  if (jsonSchema.type === "object" && recordOf(value) === undefined) return false;
  if (jsonSchema.type === "array" && !Array.isArray(value)) return false;
  if (!Array.isArray(jsonSchema.required)) return true;
  const record = recordOf(value);
  return (
    record !== undefined &&
    jsonSchema.required.every((field) => typeof field === "string" && Object.hasOwn(record, field))
  );
};

const diagnosticOutput = (text: string): { readonly text: string; readonly truncated: boolean } => {
  const bytes = Buffer.from(text);
  return bytes.byteLength <= AUTHORING_OUTPUT_DIAGNOSTIC_BYTES
    ? { text, truncated: false }
    : {
        text: bytes.subarray(0, AUTHORING_OUTPUT_DIAGNOSTIC_BYTES).toString("utf8"),
        truncated: true
      };
};

const causeMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);

export const evalAuthoringResponseStatusFailureDetail = (
  payload: unknown,
  callId?: string | null,
  maximumOutputTokens?: number
): string | undefined => {
  const response = recordOf(payload);
  const status = response?.status;
  const usage = recordOf(response?.usage);
  const outputTokens =
    typeof usage?.output_tokens === "number"
      ? usage.output_tokens
      : typeof usage?.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined;
  const reachedOutputLimit =
    maximumOutputTokens !== undefined &&
    outputTokens !== undefined &&
    outputTokens >= maximumOutputTokens;
  if (status !== "incomplete" && status !== "failed" && !reachedOutputLimit) {
    return undefined;
  }
  const details =
    status === "incomplete" ? recordOf(response?.incomplete_details) : recordOf(response?.error);
  const reason =
    typeof details?.reason === "string"
      ? details.reason
      : typeof details?.code === "string"
        ? details.code
        : reachedOutputLimit
          ? "max_output_tokens"
          : undefined;
  return [
    status === "incomplete" || reachedOutputLimit
      ? "author model response was incomplete"
      : "author model response failed",
    ...(reason === undefined ? [] : [`stop reason ${reason}`]),
    callId === undefined || callId === null || callId.length === 0
      ? "call id unavailable"
      : `call id ${callId}`
  ].join("; ");
};

const structuredOutputResult = (input: {
  readonly text: string;
  readonly schemaName: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
}): { readonly text: string } | { readonly parsedJson: boolean; readonly parseError?: unknown } => {
  let parseError: unknown;
  let parsedJson = false;
  for (const candidate of jsonCandidates(input.text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate) as unknown;
      parsedJson = true;
    } catch (cause) {
      parseError ??= cause;
      continue;
    }
    const unwrapped = wrapperValues(parsed, input.schemaName)
      .map(parseWrappedValue)
      .filter((value) => value !== undefined);
    for (const value of [...unwrapped, parsed]) {
      if (matchesSchemaRoot(value, input.jsonSchema)) return { text: JSON.stringify(value) };
    }
  }
  return { parsedJson, ...(parseError === undefined ? {} : { parseError }) };
};

export const evalAuthoringStructuredOutput = (input: {
  readonly operation: EvalProjectAuthoringError["operation"];
  readonly text: string;
  readonly callId?: string | null;
  readonly schemaName: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
}): Effect.Effect<string, EvalProjectAuthoringError> => {
  const result = structuredOutputResult(input);
  if ("text" in result) return Effect.succeed(result.text);
  const { parsedJson, parseError } = result;
  const output = diagnosticOutput(input.text);
  const detail = [
    parsedJson
      ? `author model returned JSON outside requested ${input.schemaName} schema`
      : "author model returned invalid JSON",
    ...(!parsedJson && parseError !== undefined ? [`parse error ${causeMessage(parseError)}`] : []),
    input.callId === undefined || input.callId === null || input.callId.length === 0
      ? "call id unavailable"
      : `call id ${input.callId}`,
    `author output ${JSON.stringify(output.text)}${output.truncated ? "… (truncated)" : ""}`
  ].join("; ");
  return Effect.fail(authoringFailure(input.operation, detail, parseError));
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
      const callId = response.headers.get(MODEL_CALL_ID_HEADER);
      const responseStatusFailure = evalAuthoringResponseStatusFailureDetail(
        payload,
        callId,
        input.maximumOutputTokens
      );
      if (responseStatusFailure !== undefined) {
        return yield* authoringFailure(operation, responseStatusFailure);
      }
      const text = outputText(payload, input.schemaName);
      if (text === undefined) {
        return yield* authoringFailure(
          operation,
          `author model returned no structured output; ${
            callId === null || callId.length === 0 ? "call id unavailable" : `call id ${callId}`
          }`
        );
      }
      if (Buffer.byteLength(text) > AUTHORING_OUTPUT_BYTES) {
        const output = diagnosticOutput(text);
        return yield* authoringFailure(
          operation,
          [
            "author model returned output above the structured output bound",
            callId === null || callId.length === 0 ? "call id unavailable" : `call id ${callId}`,
            `author output ${JSON.stringify(output.text)}… (truncated)`
          ].join("; ")
        );
      }
      return yield* evalAuthoringStructuredOutput({
        operation,
        text,
        callId,
        schemaName: input.schemaName,
        jsonSchema: input.jsonSchema
      });
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
