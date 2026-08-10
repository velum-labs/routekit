import { randomId } from "@velum-labs/routekit-runtime";

import { jsonResponse } from "./http-response.js";
import type { Backend, BackendRequestOptions } from "./backend.js";
import { SseDecoder, SseParseError } from "./sse/parse.js";
import type { CanonicalReasoningDetail } from "./adapters/openai-chat-wire.js";

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
  reasoning_details?: CanonicalReasoningDetail[];
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
};

export type ProviderTransport = (
  url: string,
  init: RequestInit,
  options?: BackendRequestOptions
) => Promise<Response>;

export abstract class HttpProviderBackend implements Backend {
  readonly defaultModel: string | undefined;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly extraHeaders: Record<string, string>;
  readonly transport: ProviderTransport;

  constructor(options: ProviderBackendOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.extraHeaders = options.headers ?? {};
    this.transport = options.transport ?? (async (url, init) => await fetch(url, init));
  }

  listModelIds(): readonly string[] {
    return this.defaultModel === undefined ? [] : [this.defaultModel];
  }

  servesModel(model: string): boolean {
    return this.defaultModel === undefined || model === this.defaultModel;
  }

  models(): Promise<Response> {
    const data = this.listModelIds().map((id) => ({ id, object: "model", owned_by: "provider" }));
    return Promise.resolve(
      new Response(JSON.stringify({ object: "list", data }), {
        headers: { "content-type": "application/json" }
      })
    );
  }

  embeddings(): Promise<Response> {
    return Promise.resolve(
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
  ): Promise<Response>;
}

export function bodyRecord(body: unknown): ChatBody {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as ChatBody)
    : {};
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      "text" in part &&
      typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : []
    )
    .join("");
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

export function normalizedOpenAiUsage(usage: unknown): unknown {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return usage;
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
    ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
    ...(completionTokens !== undefined ? { completion_tokens: completionTokens } : {}),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {})
  };
}

export function mapSse(
  response: Response,
  mapper: (event: string, data: unknown) => readonly unknown[]
): Response {
  if (response.body === null) return response;
  const decoder = new SseDecoder();
  const encoder = new TextEncoder();
  const mapEvents = (
    events: ReturnType<SseDecoder["feed"]>,
    controller: TransformStreamDefaultController<Uint8Array>
  ): void => {
    for (const event of events) {
      const raw = event.data.trim();
      if (raw.length === 0 || raw === "[DONE]") continue;
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new SseParseError(
          "provider SSE event contained malformed JSON",
          raw.slice(0, 200)
        );
      }
      for (const mapped of mapper(event.event ?? "message", data)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(mapped)}\n\n`));
      }
    }
  };
  const transformed = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        mapEvents(decoder.feed(chunk), controller);
      },
      flush(controller) {
        mapEvents(decoder.flush(), controller);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    })
  );
  return new Response(transformed, {
    status: response.status,
    headers: { "content-type": "text/event-stream; charset=utf-8" }
  });
}
