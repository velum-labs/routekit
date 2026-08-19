import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { trimTrailingSlashes } from "@velum-labs/routekit-runtime/network";
import { Context, Data, Effect, Layer, Scope } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http";

import type { AgentRuntimeEvent } from "../vendor/framework/contracts/author/src/agent-event.ts";

const LOOPBACK_HOST = "127.0.0.1";
const INVOKE_PATH = "/api/invoke";
const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";
const EVAL_ATTRIBUTION_HEADER = "x-routekit-eval-attribution";
const FORBIDDEN_MODELS = new Set(["auto", "router", "default"]);
const EXPLICIT_MODEL = /^[^/\s]+\/[^/\s]+$/u;
const HARNESS_NAME = "routekit-gateway";

export interface RouteKitEvalGatewayBridgeOptions {
  /** OpenAI-compatible RouteKit data-plane origin. */
  readonly gatewayOrigin: string;
  /** Injected data-plane bearer credential. It is held only by this parent process. */
  readonly bearerCredential: string;
  /** Exact candidate models authorized for this comparison. */
  readonly candidateModels: readonly string[];
  /** Exact comparison id authorized for bridge requests. */
  readonly comparisonId: string;
  /** Exact judge model authorized for this comparison. */
  readonly judgeModel: string;
  /** Authoritative per-call output-token ceiling from the eval manifest. */
  readonly maxOutputTokens?: number;
}

export interface RouteKitEvalGatewayBridgeService {
  readonly hostname: typeof LOOPBACK_HOST;
  readonly origin: string;
  readonly port: number;
}

export class RouteKitEvalGatewayBridge extends Context.Service<
  RouteKitEvalGatewayBridge,
  RouteKitEvalGatewayBridgeService
>()("@velum-labs/routekit-eval-engine/RouteKitEvalGatewayBridge") {}

export class RouteKitEvalGatewayBridgeConfigurationError extends Data.TaggedError(
  "RouteKitEvalGatewayBridgeConfigurationError"
)<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

export class RouteKitEvalGatewayBridgeStartError extends Data.TaggedError(
  "RouteKitEvalGatewayBridgeStartError"
)<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return "Could not start the scoped RouteKit Eval gateway bridge.";
  }
}

class InvokeRequestError extends Data.TaggedError("InvokeRequestError")<{
  readonly detail: string;
}> {}

class GatewayRequestError extends Data.TaggedError("GatewayRequestError")<{
  readonly detail: string;
  readonly status?: number;
}> {}

type EvalRole = "candidate" | "judge";

interface InvokeCommand {
  readonly comparisonId: string;
  readonly commandId: string;
  readonly model: string;
  readonly outputSchema?: {
    readonly name?: string;
    readonly schema: unknown;
  };
  readonly parameters?: {
    readonly reasoning?: {
      readonly effort?: string;
    };
  };
  readonly prompt: string;
  readonly role: EvalRole;
  readonly runKey: string;
  readonly systemPrompt?: string;
  readonly temperature?: number;
  readonly type: "agent.invoke";
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const explicitModel = (value: unknown): string | undefined => {
  const model = nonEmptyString(value);
  if (model === undefined) return undefined;
  const normalized = model.trim().toLowerCase();
  if (FORBIDDEN_MODELS.has(normalized) || !EXPLICIT_MODEL.test(model)) {
    return undefined;
  }
  return model;
};

const optionalString = (
  record: Readonly<Record<string, unknown>>,
  key: string
): string | undefined | InvokeRequestError => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return new InvokeRequestError({ detail: `${key} must be a string when provided.` });
};

const decodeInvokeCommand = (value: unknown): Effect.Effect<InvokeCommand, InvokeRequestError> =>
  Effect.gen(function* () {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return yield* new InvokeRequestError({ detail: "Request body must be a JSON object." });
    }
    const record = value as Readonly<Record<string, unknown>>;
    if (record.type !== "agent.invoke") {
      return yield* new InvokeRequestError({ detail: 'type must be "agent.invoke".' });
    }
    const model = explicitModel(record.model);
    if (model === undefined) {
      return yield* new InvokeRequestError({
        detail: "model must be an explicit provider/model id."
      });
    }
    const prompt = nonEmptyString(record.prompt);
    if (prompt === undefined) {
      return yield* new InvokeRequestError({ detail: "prompt must not be empty." });
    }
    const commandId = nonEmptyString(record.commandId);
    const comparisonId = nonEmptyString(record.comparisonId);
    const runKey = nonEmptyString(record.runKey);
    if (commandId === undefined || comparisonId === undefined || runKey === undefined) {
      return yield* new InvokeRequestError({
        detail: "commandId, comparisonId, and runKey must not be empty."
      });
    }
    if (record.role !== "candidate" && record.role !== "judge") {
      return yield* new InvokeRequestError({
        detail: 'role must be either "candidate" or "judge".'
      });
    }
    const systemPrompt = optionalString(record, "systemPrompt");
    if (systemPrompt instanceof InvokeRequestError) return yield* systemPrompt;
    if (record.temperature !== undefined && typeof record.temperature !== "number") {
      return yield* new InvokeRequestError({ detail: "temperature must be a number." });
    }

    let outputSchema: InvokeCommand["outputSchema"];
    if (record.outputSchema !== undefined) {
      if (
        record.outputSchema === null ||
        typeof record.outputSchema !== "object" ||
        Array.isArray(record.outputSchema) ||
        !("schema" in record.outputSchema)
      ) {
        return yield* new InvokeRequestError({
          detail: "outputSchema must contain a JSON Schema."
        });
      }
      const schemaRecord = record.outputSchema as Readonly<Record<string, unknown>>;
      const name = optionalString(schemaRecord, "name");
      if (name instanceof InvokeRequestError) return yield* name;
      outputSchema = {
        schema: schemaRecord.schema,
        ...(name === undefined ? {} : { name })
      };
    }

    let parameters: InvokeCommand["parameters"];
    if (record.parameters !== undefined) {
      if (record.parameters === null || typeof record.parameters !== "object") {
        return yield* new InvokeRequestError({ detail: "parameters must be an object." });
      }
      const reasoning = (record.parameters as Readonly<Record<string, unknown>>).reasoning;
      if (reasoning !== undefined) {
        if (reasoning === null || typeof reasoning !== "object") {
          return yield* new InvokeRequestError({
            detail: "parameters.reasoning must be an object."
          });
        }
        const effort = (reasoning as Readonly<Record<string, unknown>>).effort;
        if (effort !== undefined && typeof effort !== "string") {
          return yield* new InvokeRequestError({
            detail: "parameters.reasoning.effort must be a string."
          });
        }
        parameters = { reasoning: { ...(effort === undefined ? {} : { effort }) } };
      } else {
        parameters = {};
      }
    }

    return {
      commandId,
      comparisonId,
      model,
      prompt,
      role: record.role,
      runKey,
      type: "agent.invoke",
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(record.temperature === undefined ? {} : { temperature: record.temperature as number }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(parameters === undefined ? {} : { parameters })
    };
  });

const safeSchemaName = (name: string | undefined): string => {
  const normalized = (name ?? "routekit_eval_output").replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);
  return normalized.length === 0 ? "routekit_eval_output" : normalized;
};

const gatewayBody = (
  command: InvokeCommand,
  maxOutputTokens: number | undefined
): Record<string, unknown> => ({
  model: command.model,
  messages: [
    ...(command.systemPrompt === undefined
      ? []
      : [{ role: "system", content: command.systemPrompt }]),
    { role: "user", content: command.prompt }
  ],
  stream: false,
  ...(maxOutputTokens === undefined ? {} : { max_completion_tokens: maxOutputTokens }),
  ...(command.parameters?.reasoning?.effort === undefined
    ? {}
    : { reasoning_effort: command.parameters.reasoning.effort }),
  ...(command.temperature === undefined ? {} : { temperature: command.temperature }),
  ...(command.outputSchema === undefined
    ? {}
    : {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: safeSchemaName(command.outputSchema.name),
            schema: command.outputSchema.schema,
            strict: true
          }
        }
      })
});

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const completionText = (payload: unknown): string | undefined => {
  const choices = asRecord(payload)?.choices;
  if (!Array.isArray(choices)) return undefined;
  const message = asRecord(asRecord(choices[0])?.message);
  return typeof message?.content === "string" ? message.content : undefined;
};

interface BridgeRuntimeUsage {
  readonly costUsd?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const completionUsage = (payload: unknown): BridgeRuntimeUsage | undefined => {
  const root = asRecord(payload);
  const usage = asRecord(root?.usage);
  const inputTokens = finiteNonNegative(usage?.prompt_tokens);
  const outputTokens = finiteNonNegative(usage?.completion_tokens);
  // Omitting the entire measurement is safer than manufacturing the missing
  // half as zero.
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const providerCost = asRecord(root?.provider_cost);
  const costUsd =
    finiteNonNegative(usage?.cost_usd) ??
    finiteNonNegative(usage?.costUsd) ??
    finiteNonNegative(root?.cost_usd) ??
    finiteNonNegative(root?.costUsd) ??
    finiteNonNegative(providerCost?.cost_usd);
  return {
    inputTokens,
    outputTokens,
    ...(costUsd === undefined ? {} : { costUsd })
  };
};

const structuredData = (content: string): unknown => {
  const trimmed = content.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)?.[1];
    if (fenced === undefined) return undefined;
    try {
      return JSON.parse(fenced);
    } catch {
      return undefined;
    }
  }
};

const event = (
  model: string,
  value: { readonly type: AgentRuntimeEvent["type"]; readonly payload: unknown }
): AgentRuntimeEvent => ({ ...value, harness: HARNESS_NAME, model }) as AgentRuntimeEvent;

const runtimeNdjson = (command: InvokeCommand, payload: unknown): string => {
  const content = completionText(payload);
  if (content === undefined) {
    throw new GatewayRequestError({
      detail: "RouteKit gateway response did not contain assistant text."
    });
  }
  // Provider adapters may return a provider-local model name (for example
  // `gpt-5.4-mini`) even though RouteKit authorized and routed the fully
  // qualified `codex/gpt-5.4-mini`. Evidence must retain the exact requested
  // RouteKit ID so candidate/judge authorization and policy compilation agree.
  const model = command.model;
  const usage = completionUsage(payload);
  const data = structuredData(content);
  const events: readonly AgentRuntimeEvent[] = [
    event(model, {
      type: "run.started",
      payload: { prompt: command.prompt, model: command.model }
    }),
    event(model, {
      type: "session.started",
      payload: { sessionId: command.commandId }
    }),
    event(model, { type: "turn.started", payload: { prompt: command.prompt } }),
    ...(content.length === 0
      ? []
      : [
          event(model, {
            type: "assistant.text.delta",
            payload: { delta: content }
          })
        ]),
    event(model, {
      type: "item.completed",
      payload: {
        itemType: "message",
        ...(data === undefined ? {} : { data })
      }
    }),
    event(model, {
      type: "turn.succeeded",
      payload: { ...(usage === undefined ? {} : { usage }) }
    })
  ];
  return `${events
    .map((runtimeEvent) => JSON.stringify({ type: "runtime.event", event: runtimeEvent }))
    .join("\n")}\n`;
};

const makeGatewayRequest = (
  options: RouteKitEvalGatewayBridgeOptions,
  command: InvokeCommand
): HttpClientRequest.HttpClientRequest => {
  const gatewayUrl = new URL(options.gatewayOrigin);
  const basePath = trimTrailingSlashes(gatewayUrl.pathname);
  gatewayUrl.pathname =
    basePath === "/v1" ? "/v1/chat/completions" : `${basePath}/v1/chat/completions`;
  return HttpClientRequest.post(gatewayUrl, {
    body: HttpBody.jsonUnsafe(gatewayBody(command, options.maxOutputTokens)),
    headers: {
      authorization: `Bearer ${options.bearerCredential}`,
      [EVAL_ATTRIBUTION_HEADER]: JSON.stringify({
        purpose: "eval",
        role: command.role,
        runId: command.comparisonId,
        caseId: command.runKey
      }),
      [EVAL_POLICY_BYPASS_HEADER]: "1"
    }
  });
};

const invoke = Effect.fn("RouteKitEvalGatewayBridge.invoke")(function* (
  client: HttpClient.HttpClient,
  options: RouteKitEvalGatewayBridgeOptions,
  raw: unknown
) {
  const command = yield* decodeInvokeCommand(raw);
  if (command.comparisonId !== options.comparisonId) {
    return yield* new InvokeRequestError({
      detail: "comparisonId is not authorized for this RouteKit Eval bridge."
    });
  }
  if (
    (command.role === "candidate" && !options.candidateModels.includes(command.model)) ||
    (command.role === "judge" && command.model !== options.judgeModel)
  ) {
    return yield* new InvokeRequestError({
      detail: `${command.role} model is not authorized for this RouteKit Eval comparison.`
    });
  }
  const response = yield* client.execute(makeGatewayRequest(options, command)).pipe(
    Effect.mapError(
      (cause) =>
        new GatewayRequestError({
          detail: "RouteKit gateway request failed."
        })
    )
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* new GatewayRequestError({
      detail: `RouteKit gateway request failed with HTTP ${response.status}.`,
      status: response.status
    });
  }
  const payload = yield* response.json.pipe(
    Effect.mapError(
      (cause) =>
        new GatewayRequestError({
          detail: "RouteKit gateway returned invalid JSON."
        })
    )
  );
  return yield* Effect.try({
    try: () => runtimeNdjson(command, payload),
    catch: (cause) =>
      cause instanceof GatewayRequestError
        ? cause
        : new GatewayRequestError({
            detail: "RouteKit gateway response could not be translated."
          })
  });
});

const makeHttpApp = (client: HttpClient.HttpClient, options: RouteKitEvalGatewayBridgeOptions) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (
      request.method !== "POST" ||
      new URL(request.url, "http://localhost").pathname !== INVOKE_PATH
    ) {
      return HttpServerResponse.jsonUnsafe(
        { error: { code: "not_found", message: "RouteKit Eval bridge route not found." } },
        { status: 404 }
      );
    }
    const raw = yield* request.json.pipe(
      Effect.mapError(() => new InvokeRequestError({ detail: "Request body must be valid JSON." }))
    );
    const body = yield* invoke(client, options, raw);
    return HttpServerResponse.text(body, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8" }
    });
  }).pipe(
    Effect.catch((cause) => {
      const isInput = cause instanceof InvokeRequestError;
      return Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          {
            error: {
              code: isInput ? "invalid_request" : "gateway_failure",
              message: isInput ? cause.detail : "RouteKit Eval gateway call failed."
            }
          },
          { status: isInput ? 400 : 502 }
        )
      );
    })
  );

const validateOptions = (
  options: RouteKitEvalGatewayBridgeOptions
): Effect.Effect<string, RouteKitEvalGatewayBridgeConfigurationError> =>
  Effect.gen(function* () {
    if (options.bearerCredential.length === 0) {
      return yield* new RouteKitEvalGatewayBridgeConfigurationError({
        detail: "RouteKit Eval gateway bearer credential must not be empty."
      });
    }
    if (options.comparisonId.trim().length === 0) {
      return yield* new RouteKitEvalGatewayBridgeConfigurationError({
        detail: "RouteKit Eval bridge comparisonId must not be empty."
      });
    }
    if (
      options.candidateModels.length === 0 ||
      options.candidateModels.some((model) => explicitModel(model) === undefined)
    ) {
      return yield* new RouteKitEvalGatewayBridgeConfigurationError({
        detail:
          "RouteKit Eval bridge candidate models must be nonempty explicit provider/model ids."
      });
    }
    if (explicitModel(options.judgeModel) === undefined) {
      return yield* new RouteKitEvalGatewayBridgeConfigurationError({
        detail: "RouteKit Eval bridge judge model must be an explicit provider/model id."
      });
    }
    if (
      options.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)
    ) {
      return yield* new RouteKitEvalGatewayBridgeConfigurationError({
        detail: "RouteKit Eval bridge maxOutputTokens must be a positive safe integer."
      });
    }
    const origin = yield* Effect.try({
      try: () => new URL(options.gatewayOrigin),
      catch: () =>
        new RouteKitEvalGatewayBridgeConfigurationError({
          detail: "RouteKit Eval gateway origin must be an absolute HTTP(S) URL."
        })
    });
    const supportedPath =
      origin.pathname === "/" || origin.pathname === "/v1" || origin.pathname === "/v1/";
    if (
      (origin.protocol !== "http:" && origin.protocol !== "https:") ||
      origin.username.length > 0 ||
      origin.password.length > 0 ||
      !supportedPath ||
      origin.search.length > 0 ||
      origin.hash.length > 0
    ) {
      return yield* new RouteKitEvalGatewayBridgeConfigurationError({
        detail:
          "RouteKit Eval gateway origin must be an absolute HTTP(S) RouteKit origin or /v1 base without credentials, query, or fragment."
      });
    }
    return origin.origin;
  });

/**
 * Start a parent-owned, ephemeral loopback bridge for generated RouteKit Eval
 * SDK calls. Listener and in-flight request fibers are tied to the caller's
 * Scope. The bearer credential is used only by the injected HttpClient and is
 * never returned in the bridge handle or included in diagnostics.
 */
export const makeRouteKitEvalGatewayBridge = (
  options: RouteKitEvalGatewayBridgeOptions
): Effect.Effect<
  RouteKitEvalGatewayBridgeService,
  RouteKitEvalGatewayBridgeConfigurationError | RouteKitEvalGatewayBridgeStartError,
  HttpClient.HttpClient | Scope.Scope
> =>
  Effect.gen(function* () {
    const gatewayOrigin = yield* validateOptions(options);
    const normalizedOptions: RouteKitEvalGatewayBridgeOptions = {
      ...options,
      gatewayOrigin
    };
    const client = yield* HttpClient.HttpClient;
    const server = yield* NodeHttpServer.make(() => createServer(), {
      host: LOOPBACK_HOST,
      port: 0
    }).pipe(Effect.mapError((cause) => new RouteKitEvalGatewayBridgeStartError({ cause })));
    yield* server.serve(makeHttpApp(client, normalizedOptions));
    if (server.address._tag !== "TcpAddress") {
      return yield* new RouteKitEvalGatewayBridgeStartError({
        cause: new Error("RouteKit Eval gateway bridge did not bind TCP.")
      });
    }
    return {
      hostname: LOOPBACK_HOST,
      origin: `http://${LOOPBACK_HOST}:${server.address.port}`,
      port: server.address.port
    };
  });

export const makeRouteKitEvalGatewayBridgeLayer = (
  options: RouteKitEvalGatewayBridgeOptions
): Layer.Layer<
  RouteKitEvalGatewayBridge,
  RouteKitEvalGatewayBridgeConfigurationError | RouteKitEvalGatewayBridgeStartError,
  HttpClient.HttpClient
> => Layer.effect(RouteKitEvalGatewayBridge)(makeRouteKitEvalGatewayBridge(options));
