import type { Reasoning, Usage } from "@velum-labs/routekit-contracts/protocol-ir";
import {
  conversationFromOpenAiMessages,
  conversationText
} from "@velum-labs/routekit-contracts/protocol-ir";
import { randomId } from "@velum-labs/routekit-runtime";
import {
  executeWebRequest,
  type RouteKitPlatform,
  routeKitError
} from "@velum-labs/routekit-runtime/effect";
import { StreamPump } from "@velum-labs/routekit-runtime/sse";
import { type Context, Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";
import {
  type Backend,
  type BackendPorts,
  type BackendRequest,
  type BackendRequestOptions,
  staticBackendModelPort
} from "./backend.js";
import { jsonResponse } from "./http-response.js";
import type { ProviderRecord } from "./provider-protocol.js";
import { SseParseError } from "./sse/parse.js";

export function invalidReasoningControlResponse(
  message: string,
  metadata = false,
  path?: string
): Response {
  return jsonResponse(
    {
      error: {
        type: "invalid_request_error",
        code: metadata ? "invalid_reasoning_metadata" : "invalid_reasoning_control",
        ...(path !== undefined ? { param: path } : {}),
        message
      }
    },
    400
  );
}

export type ChatMessage = {
  role?: string;
  content?: unknown;
  reasoning?: string;
  reasoning_details?: Reasoning[];
  tool_calls?: Array<{
    id?: string;
    index?: number;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
};

export type ChatBody = {
  model?: string;
  messages?: ChatMessage[];
  tools?: Array<{ type?: string; function?: Record<string, unknown> }>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  reasoning_effort?: string;
};

export type ProviderBackendOptions = {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  transport?: ProviderTransport;
  forceStream?: boolean;
  omitSampling?: boolean;
  platform?: Context.Context<RouteKitPlatform>;
};

export type ProviderTransport = (
  url: string,
  init: RequestInit,
  options?: BackendRequestOptions
) => Effect.Effect<Response, Error, RouteKitPlatform>;

export function defaultProviderTransport(
  url: string,
  init: RequestInit
): Effect.Effect<Response, Error, HttpClient.HttpClient> {
  return executeWebRequest(url, init).pipe(Effect.mapError((error) => routeKitError(error)));
}

export function provideCapturedPlatform<A, E, R>(
  platform: Context.Context<RouteKitPlatform> | undefined,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return platform === undefined ? effect : Effect.provide(effect, platform);
}

export function providerTransport(
  transport: ProviderTransport,
  url: string,
  init: RequestInit,
  options?: BackendRequestOptions,
  platform?: Context.Context<RouteKitPlatform>
): BackendRequest {
  return provideCapturedPlatform(platform, transport(url, init, options)) as BackendRequest;
}

export abstract class HttpProviderBackend implements Backend {
  readonly ports: BackendPorts;
  readonly defaultModel: string | undefined;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly extraHeaders: Record<string, string>;
  readonly transport: ProviderTransport;
  readonly platform: Context.Context<RouteKitPlatform> | undefined;

  constructor(options: ProviderBackendOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.extraHeaders = options.headers ?? {};
    this.transport = options.transport ?? defaultProviderTransport;
    this.platform = options.platform;
    this.ports = {
      models: {
        ...staticBackendModelPort(this.defaultModel),
        reasoningWireShape: (model) => this.reasoningWireShape(model)
      },
      responses: { kind: "unsupported" },
      lifecycle: { kind: "borrowed" }
    };
  }

  reasoningWireShape(_model: string): string | undefined {
    return undefined;
  }

  listModelIds(): readonly string[] {
    return this.defaultModel === undefined ? [] : [this.defaultModel];
  }

  servesModel(model: string): boolean {
    return this.defaultModel === undefined || model === this.defaultModel;
  }

  models(): BackendRequest {
    const data = this.listModelIds().map((id) => ({ id, object: "model", owned_by: "provider" }));
    return Effect.succeed(
      new Response(JSON.stringify({ object: "list", data }), {
        headers: { "content-type": "application/json" }
      })
    );
  }

  embeddings(): BackendRequest {
    return Effect.succeed(
      new Response(JSON.stringify({ error: { message: "embeddings are not supported" } }), {
        status: 501,
        headers: { "content-type": "application/json" }
      })
    );
  }

  abstract chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): BackendRequest;
}

export function bodyRecord(body: unknown): ChatBody {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as ChatBody)
    : {};
}

export function textContent(content: unknown): string {
  const conversation = conversationFromOpenAiMessages([{ role: "user", content }]);
  const message = conversation.messages[0];
  return message === undefined ? "" : conversationText(message);
}

export function chatCompletion(
  model: string,
  message: Record<string, unknown>,
  usage?: unknown,
  finishReason = "stop",
  choiceMetadata: Record<string, unknown> = {}
): unknown {
  return {
    id: randomId(18, "chatcmpl_"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, ...choiceMetadata }],
    ...(usage !== undefined ? { usage } : {})
  };
}

export function normalizedOpenAiUsage(usage: unknown): Record<string, unknown> | undefined {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return undefined;
  const value = usage as Record<string, unknown>;
  const promptTokens = value.prompt_tokens ?? value.input_tokens;
  const completionTokens = value.completion_tokens ?? value.output_tokens;
  const totalTokens =
    value.total_tokens ??
    (typeof promptTokens === "number" && typeof completionTokens === "number"
      ? promptTokens + completionTokens
      : undefined);
  return {
    ...value,
    ...(typeof promptTokens === "number" ? { prompt_tokens: promptTokens } : {}),
    ...(typeof completionTokens === "number" ? { completion_tokens: completionTokens } : {}),
    ...(typeof totalTokens === "number" ? { total_tokens: totalTokens } : {})
  };
}

export function mapSse(
  response: Response,
  mapper: (event: string, data: ProviderRecord) => readonly unknown[],
  decode: (data: unknown, event: string) => ProviderRecord
): Response {
  if (response.body === null) return response;
  const encoder = new TextEncoder();
  const transformed = StreamPump.sse(response.body, {
    onEvent(event, controller) {
      const raw = event.data.trim();
      if (raw.length === 0 || raw === "[DONE]") return;
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch (error) {
        throw new SseParseError("provider SSE event contained malformed JSON", raw.slice(0, 200));
      }
      const eventType = event.event ?? "message";
      for (const mapped of mapper(eventType, decode(data, eventType))) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(mapped)}\n\n`));
      }
    },
    onEnd(controller) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    }
  });
  return new Response(transformed, {
    status: response.status,
    headers: { "content-type": "text/event-stream; charset=utf-8" }
  });
}
