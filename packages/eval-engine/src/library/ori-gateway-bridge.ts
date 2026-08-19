import { randomBytes, timingSafeEqual } from "node:crypto";
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

const LOOPBACK_HOST = "127.0.0.1";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const MESSAGES_PATH = "/v1/messages";
const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";
const MODELS_PATH = "/v1/models";
const ENDPOINTS_SUFFIX = "/endpoints";
const INFERENCE_PATHS = new Set([CHAT_COMPLETIONS_PATH, MESSAGES_PATH, COUNT_TOKENS_PATH]);
const ANTHROPIC_REQUEST_KEYS = [
  "model",
  "system",
  "messages",
  "max_tokens",
  "temperature",
  "top_p",
  "top_k",
  "thinking",
  "output_config",
  "metadata",
  "stop_sequences",
  "stream",
  "tools",
  "tool_choice"
] as const;
const OPENAI_CHAT_REQUEST_KEYS = [
  "model",
  "messages",
  "temperature",
  "top_p",
  "n",
  "stream",
  "stop",
  "max_tokens",
  "max_completion_tokens",
  "reasoning_effort",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "user",
  "tools",
  "tool_choice",
  "response_format",
  "seed",
  "logprobs",
  "top_logprobs",
  "parallel_tool_calls"
] as const;
const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";
const EVAL_ATTRIBUTION_HEADER = "x-routekit-eval-attribution";
const FORBIDDEN_MODELS = new Set(["auto", "router", "default"]);
const EXPLICIT_MODEL = /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/u;

type JsonRecord = Readonly<Record<string, unknown>>;

export type OriRouteKitModelAllowance = readonly string[] | ((modelId: string) => boolean);

export interface OriRouteKitGatewayAttribution {
  readonly runId: string;
  readonly caseId?: string;
}

export interface OriRouteKitGatewayBridgeOptions {
  /** OpenAI-compatible RouteKit data-plane origin. */
  readonly gatewayOrigin: string;
  /** Real RouteKit data-plane credential. It never leaves this parent-owned bridge. */
  readonly bearerCredential: string;
  /** Models exposed to and accepted from the Ori child. */
  readonly allowModel: OriRouteKitModelAllowance;
  /** Catalog model used for authoring calls. */
  readonly authorModel: string;
  /** Catalog model used for judging calls. */
  readonly judgeModel: string;
  /** Stable attribution attached by the parent rather than trusted from the child. */
  readonly attribution: OriRouteKitGatewayAttribution;
}

export interface OriRouteKitGatewayBridgeService {
  readonly hostname: typeof LOOPBACK_HOST;
  readonly origin: string;
  readonly port: number;
  /** Ephemeral credential intended for the scoped Ori child only. */
  readonly childCredential: string;
  readonly authorModel: string;
  readonly judgeModel: string;
  readonly models: readonly string[];
}

export class OriRouteKitGatewayBridge extends Context.Service<
  OriRouteKitGatewayBridge,
  OriRouteKitGatewayBridgeService
>()("@velum-labs/routekit-eval-engine/OriRouteKitGatewayBridge") {}

export class OriRouteKitGatewayBridgeConfigurationError extends Data.TaggedError(
  "OriRouteKitGatewayBridgeConfigurationError"
)<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

export class OriRouteKitGatewayBridgeStartError extends Data.TaggedError(
  "OriRouteKitGatewayBridgeStartError"
)<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return "Could not start the scoped Ori RouteKit gateway bridge.";
  }
}

class OriBridgeRequestError extends Data.TaggedError("OriBridgeRequestError")<{
  readonly code: "invalid_request" | "not_found" | "unauthorized";
  readonly detail: string;
  readonly status: 400 | 401 | 404;
}> {}

class OriBridgeGatewayError extends Data.TaggedError("OriBridgeGatewayError")<{
  readonly detail: string;
}> {}

interface CatalogSnapshot {
  readonly entries: readonly JsonRecord[];
  readonly byId: ReadonlyMap<string, JsonRecord>;
}

const asRecord = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const explicitModel = (value: unknown): string | undefined => {
  const model = nonEmptyString(value);
  if (model === undefined) return undefined;
  const stripped =
    model.startsWith("openrouter/") && model.slice("openrouter/".length).includes("/")
      ? model.slice("openrouter/".length)
      : model;
  if (FORBIDDEN_MODELS.has(stripped.trim().toLowerCase()) || !EXPLICIT_MODEL.test(stripped)) {
    return undefined;
  }
  return stripped;
};

const gatewayUrl = (origin: string, path: string): URL => {
  const url = new URL(origin);
  const basePath = trimTrailingSlashes(url.pathname);
  url.pathname = basePath === "/v1" ? path : `${basePath}${path}`;
  url.search = "";
  return url;
};

const isAllowedBy = (allowance: OriRouteKitModelAllowance, modelId: string): boolean =>
  typeof allowance === "function" ? allowance(modelId) : allowance.includes(modelId);

const safeAllowed = (allowance: OriRouteKitModelAllowance, modelId: string): boolean => {
  try {
    return isAllowedBy(allowance, modelId);
  } catch {
    return false;
  }
};

const validateOptions = (
  options: OriRouteKitGatewayBridgeOptions
): Effect.Effect<string, OriRouteKitGatewayBridgeConfigurationError> =>
  Effect.gen(function* () {
    if (options.bearerCredential.length === 0) {
      return yield* new OriRouteKitGatewayBridgeConfigurationError({
        detail: "Ori RouteKit gateway bearer credential must not be empty."
      });
    }
    if (options.attribution.runId.trim().length === 0) {
      return yield* new OriRouteKitGatewayBridgeConfigurationError({
        detail: "Ori RouteKit bridge attribution.runId must not be empty."
      });
    }
    if (
      explicitModel(options.authorModel) === undefined ||
      explicitModel(options.judgeModel) === undefined
    ) {
      return yield* new OriRouteKitGatewayBridgeConfigurationError({
        detail: "Ori RouteKit author and judge models must be explicit provider/model ids."
      });
    }
    if (
      !safeAllowed(options.allowModel, options.authorModel) ||
      !safeAllowed(options.allowModel, options.judgeModel)
    ) {
      return yield* new OriRouteKitGatewayBridgeConfigurationError({
        detail: "Ori RouteKit author and judge models must be accepted by allowModel."
      });
    }
    if (
      Array.isArray(options.allowModel) &&
      (options.allowModel.length === 0 ||
        options.allowModel.some((model) => explicitModel(model) === undefined))
    ) {
      return yield* new OriRouteKitGatewayBridgeConfigurationError({
        detail: "Ori RouteKit allowed models must be nonempty explicit provider/model ids."
      });
    }
    const origin = yield* Effect.try({
      try: () => new URL(options.gatewayOrigin),
      catch: () =>
        new OriRouteKitGatewayBridgeConfigurationError({
          detail: "Ori RouteKit gateway origin must be an absolute HTTP(S) URL."
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
      return yield* new OriRouteKitGatewayBridgeConfigurationError({
        detail:
          "Ori RouteKit gateway origin must be an absolute HTTP(S) RouteKit origin or /v1 base without credentials, query, or fragment."
      });
    }
    return origin.origin;
  });

const loadCatalog = (
  client: HttpClient.HttpClient,
  options: OriRouteKitGatewayBridgeOptions
): Effect.Effect<CatalogSnapshot, OriBridgeGatewayError> =>
  Effect.gen(function* () {
    const response = yield* client
      .execute(
        HttpClientRequest.get(gatewayUrl(options.gatewayOrigin, MODELS_PATH), {
          headers: { authorization: `Bearer ${options.bearerCredential}` }
        })
      )
      .pipe(
        Effect.mapError(
          () =>
            new OriBridgeGatewayError({
              detail: "RouteKit model catalog request failed."
            })
        )
      );
    if (response.status < 200 || response.status >= 300) {
      return yield* new OriBridgeGatewayError({
        detail: `RouteKit model catalog request failed with HTTP ${response.status}.`
      });
    }
    const payload = yield* response.json.pipe(
      Effect.mapError(
        () => new OriBridgeGatewayError({ detail: "RouteKit model catalog returned invalid JSON." })
      )
    );
    const data = asRecord(payload)?.data;
    if (!Array.isArray(data)) {
      return yield* new OriBridgeGatewayError({
        detail: "RouteKit model catalog did not contain a data array."
      });
    }
    const entries: JsonRecord[] = [];
    const byId = new Map<string, JsonRecord>();
    for (const value of data) {
      const entry = asRecord(value);
      const id = explicitModel(entry?.id);
      if (entry === undefined || id === undefined || !safeAllowed(options.allowModel, id)) continue;
      if (byId.has(id)) continue;
      entries.push(entry);
      byId.set(id, entry);
    }
    for (const selected of [options.authorModel, options.judgeModel]) {
      if (!byId.has(selected)) {
        return yield* new OriBridgeGatewayError({
          detail: `Selected Ori model "${selected}" is absent from the allowed RouteKit catalog.`
        });
      }
    }
    return { entries, byId };
  });

const presentedBearer = (authorization: string | undefined): string | undefined => {
  if (authorization === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  return match?.[1];
};

const presentedChildCredential = (
  request: HttpServerRequest.HttpServerRequest
): string | undefined =>
  presentedBearer(request.headers.authorization) ?? nonEmptyString(request.headers["x-api-key"]);

const credentialsEqual = (presented: string | undefined, expected: string): boolean => {
  if (presented === undefined) return false;
  const actual = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
};

const authenticate = (
  request: HttpServerRequest.HttpServerRequest,
  childCredential: string
): Effect.Effect<void, OriBridgeRequestError> =>
  credentialsEqual(presentedChildCredential(request), childCredential)
    ? Effect.void
    : Effect.fail(
        new OriBridgeRequestError({
          code: "unauthorized",
          detail: "A valid scoped Ori bridge bearer credential is required.",
          status: 401
        })
      );

const modelEndpoint = (entry: JsonRecord): JsonRecord => {
  const id = entry.id as string;
  const providerName = nonEmptyString(entry.owned_by) ?? id.slice(0, id.indexOf("/"));
  const topProvider = asRecord(entry.top_provider);
  return {
    provider_name: providerName,
    ...(nonEmptyString(entry.name) === undefined ? {} : { name: entry.name }),
    ...(typeof entry.context_length === "number"
      ? { context_length: entry.context_length }
      : typeof topProvider?.context_length === "number"
        ? { context_length: topProvider.context_length }
        : {}),
    ...(typeof topProvider?.max_completion_tokens === "number"
      ? { max_completion_tokens: topProvider.max_completion_tokens }
      : {}),
    ...(Array.isArray(entry.supported_parameters)
      ? { supported_parameters: entry.supported_parameters }
      : {}),
    ...(asRecord(entry.pricing) === undefined ? {} : { pricing: entry.pricing })
  };
};

const decodeEndpointModel = (pathname: string): string | undefined => {
  if (!pathname.startsWith(`${MODELS_PATH}/`) || !pathname.endsWith(ENDPOINTS_SUFFIX)) {
    return undefined;
  }
  const encoded = pathname.slice(
    `${MODELS_PATH}/`.length,
    pathname.length - ENDPOINTS_SUFFIX.length
  );
  if (encoded.length === 0) return undefined;
  try {
    return encoded
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return undefined;
  }
};

const inferenceAttribution = (options: OriRouteKitGatewayBridgeOptions, model: string): string =>
  JSON.stringify({
    purpose: "eval",
    role: model === options.judgeModel ? "judge" : "author",
    runId: options.attribution.runId,
    ...(options.attribution.caseId === undefined ? {} : { caseId: options.attribution.caseId })
  });

const pickKnownKeys = (
  raw: unknown,
  keys: readonly string[]
): unknown => {
  const body = asRecord(raw);
  if (body === undefined) return raw;
  const sanitized: Record<string, unknown> = {};
  for (const key of keys) {
    if (body[key] !== undefined) sanitized[key] = body[key];
  }
  return sanitized;
};

const sanitizeOpenAiChatBody = (raw: unknown): unknown => {
  const picked = pickKnownKeys(raw, OPENAI_CHAT_REQUEST_KEYS);
  if (picked === raw || picked === undefined || typeof picked !== "object" || picked === null) {
    return picked;
  }
  const sanitized: Record<string, unknown> = { ...picked };
  const model = explicitModel(sanitized.model);
  if (model !== undefined) sanitized.model = model;
  if (sanitized.max_completion_tokens === undefined && sanitized.max_tokens !== undefined) {
    sanitized.max_completion_tokens = sanitized.max_tokens;
  }
  delete sanitized.max_tokens;
  if (Array.isArray(sanitized.tools) && sanitized.tools.length > 0) {
    sanitized.reasoning_effort = "none";
  }
  return sanitized;
};

const sanitizeInferenceBody = (pathname: string, raw: unknown): unknown => {
  if (pathname === CHAT_COMPLETIONS_PATH) return sanitizeOpenAiChatBody(raw);
  if (pathname === MESSAGES_PATH || pathname === COUNT_TOKENS_PATH) {
    return pickKnownKeys(raw, ANTHROPIC_REQUEST_KEYS);
  }
  return raw;
};

const proxyInference = (
  client: HttpClient.HttpClient,
  options: OriRouteKitGatewayBridgeOptions,
  catalog: CatalogSnapshot,
  pathname: string,
  raw: unknown,
  request: HttpServerRequest.HttpServerRequest
) =>
  Effect.gen(function* () {
    const body = asRecord(raw);
    const model = explicitModel(body?.model);
    if (body === undefined || model === undefined) {
      return yield* new OriBridgeRequestError({
        code: "invalid_request",
        detail: "model must be an explicit provider/model id.",
        status: 400
      });
    }
    if (!catalog.byId.has(model)) {
      return yield* new OriBridgeRequestError({
        code: "invalid_request",
        detail: "model is not authorized for this scoped Ori bridge.",
        status: 400
      });
    }
    const anthropicVersion = nonEmptyString(request.headers["anthropic-version"]);
    const upstream = yield* client
      .execute(
        HttpClientRequest.post(gatewayUrl(options.gatewayOrigin, pathname), {
          body: HttpBody.jsonUnsafe(sanitizeInferenceBody(pathname, raw)),
          headers: {
            authorization: `Bearer ${options.bearerCredential}`,
            [EVAL_ATTRIBUTION_HEADER]: inferenceAttribution(options, model),
            [EVAL_POLICY_BYPASS_HEADER]: "1",
            ...(anthropicVersion === undefined ? {} : { "anthropic-version": anthropicVersion })
          }
        })
      )
      .pipe(
        Effect.mapError(
          () =>
            new OriBridgeGatewayError({
              detail: "RouteKit inference request failed."
            })
        )
      );
    const contentType = upstream.headers["content-type"];
    return HttpServerResponse.stream(upstream.stream, {
      status: upstream.status,
      ...(contentType === undefined ? {} : { headers: { "content-type": contentType } })
    });
  });

const requestErrorResponse = (cause: OriBridgeRequestError) =>
  HttpServerResponse.jsonUnsafe(
    { error: { code: cause.code, message: cause.detail } },
    {
      status: cause.status,
      ...(cause.status === 401 ? { headers: { "www-authenticate": "Bearer" } } : {})
    }
  );

const makeHttpApp = (
  client: HttpClient.HttpClient,
  options: OriRouteKitGatewayBridgeOptions,
  catalog: CatalogSnapshot,
  childCredential: string
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    yield* authenticate(request, childCredential);
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (request.method === "GET" && pathname === MODELS_PATH) {
      return HttpServerResponse.jsonUnsafe({ data: catalog.entries });
    }
    if (request.method === "GET") {
      const model = decodeEndpointModel(pathname);
      if (model !== undefined) {
        const entry = catalog.byId.get(model);
        if (entry === undefined) {
          return yield* new OriBridgeRequestError({
            code: "not_found",
            detail: `Unknown or disallowed model: ${model}`,
            status: 404
          });
        }
        return HttpServerResponse.jsonUnsafe({
          data: { endpoints: [modelEndpoint(entry)] }
        });
      }
    }
    if (request.method === "POST" && INFERENCE_PATHS.has(pathname)) {
      const raw = yield* request.json.pipe(
        Effect.mapError(
          () =>
            new OriBridgeRequestError({
              code: "invalid_request",
              detail: "Request body must be valid JSON.",
              status: 400
            })
        )
      );
      return yield* proxyInference(client, options, catalog, pathname, raw, request);
    }
    return yield* new OriBridgeRequestError({
      code: "not_found",
      detail: "Ori RouteKit bridge route not found.",
      status: 404
    });
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        cause instanceof OriBridgeRequestError
          ? requestErrorResponse(cause)
          : HttpServerResponse.jsonUnsafe(
              {
                error: {
                  code: "gateway_failure",
                  message: "RouteKit gateway call failed."
                }
              },
              { status: 502 }
            )
      )
    )
  );

/**
 * Starts an authenticated, parent-owned loopback bridge suitable for Ori
 * authoring and eval children. The returned token is random and scoped to this
 * listener; the real RouteKit credential is retained only by the parent
 * closure.
 */
export const makeOriRouteKitGatewayBridge = (
  options: OriRouteKitGatewayBridgeOptions
): Effect.Effect<
  OriRouteKitGatewayBridgeService,
  OriRouteKitGatewayBridgeConfigurationError | OriRouteKitGatewayBridgeStartError,
  HttpClient.HttpClient | Scope.Scope
> =>
  Effect.gen(function* () {
    const origin = yield* validateOptions(options);
    const normalizedOptions: OriRouteKitGatewayBridgeOptions = {
      ...options,
      gatewayOrigin: origin
    };
    const client = yield* HttpClient.HttpClient;
    const catalog = yield* loadCatalog(client, normalizedOptions).pipe(
      Effect.mapError((cause) => new OriRouteKitGatewayBridgeStartError({ cause }))
    );
    const childCredential = `rk_ori_${randomBytes(32).toString("base64url")}`;
    const server = yield* NodeHttpServer.make(() => createServer(), {
      host: LOOPBACK_HOST,
      port: 0
    }).pipe(Effect.mapError((cause) => new OriRouteKitGatewayBridgeStartError({ cause })));
    yield* server.serve(makeHttpApp(client, normalizedOptions, catalog, childCredential));
    if (server.address._tag !== "TcpAddress") {
      return yield* new OriRouteKitGatewayBridgeStartError({
        cause: new Error("Ori RouteKit gateway bridge did not bind TCP.")
      });
    }
    return {
      hostname: LOOPBACK_HOST,
      origin: `http://${LOOPBACK_HOST}:${server.address.port}`,
      port: server.address.port,
      childCredential,
      authorModel: normalizedOptions.authorModel,
      judgeModel: normalizedOptions.judgeModel,
      models: catalog.entries.map((entry) => entry.id as string)
    };
  });

export const makeOriRouteKitGatewayBridgeLayer = (
  options: OriRouteKitGatewayBridgeOptions
): Layer.Layer<
  OriRouteKitGatewayBridge,
  OriRouteKitGatewayBridgeConfigurationError | OriRouteKitGatewayBridgeStartError,
  HttpClient.HttpClient
> => Layer.effect(OriRouteKitGatewayBridge)(makeOriRouteKitGatewayBridge(options));
