/**
 * OpenAI HTTP backend. Speaks Chat Completions, embeddings, and native
 * Responses. Backend port types live in `backend.ts`.
 */
import { fetchViaHttpClient } from "@velum-labs/routekit-runtime/effect";
import {
  REASONING_SELECTION,
  reasoningSelectionOf,
  routeKitRequestValidationErrorOf,
  withoutRouteKitExtensions
} from "./adapters/openai-chat-wire.js";
import { normalizeOpenAiResponsesCallIds } from "./adapters/openai-responses-wire.js";
import type { Backend, BackendPorts, BackendRequestOptions } from "./backend.js";
import { joinPath, staticBackendModelPort } from "./backend.js";

export type OpenAiBackendOptions = {
  /**
   * Base URL including the OpenAI API prefix, e.g.
   * `http://127.0.0.1:8080/v1`. Route paths (`/chat/completions`, `/models`,
   * `/embeddings`) are appended to this value.
   */
  baseUrl: string;
  /**
   * Bearer credential forwarded to the backend. Local servers ignore it; the
   * default mirrors the `not-needed` placeholder the AI SDK uses for local
   * OpenAI-compatible servers.
   */
  apiKey?: string;
  /** Model id used when a request omits `model`. */
  defaultModel?: string;
  /**
   * When set, every request's `model` is overwritten with this id before it is
   * forwarded upstream, regardless of what the client sent. Used by per-candidate
   * capture gateways that are dedicated to one routed endpoint: the driving CLI
   * (e.g. Claude Code) picks its own model label, but the router must always
   * receive the routed model id. Absent means the client's model passes through.
   */
  forceModel?: string;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
};

function invalidReasoningControlResponse(
  message: string,
  metadata = false,
  path?: string
): Response {
  return Response.json(
    {
      error: {
        type: "invalid_request_error",
        code: metadata ? "invalid_reasoning_metadata" : "invalid_reasoning_control",
        ...(path !== undefined ? { param: path } : {}),
        message
      }
    },
    { status: 400 }
  );
}

/** An OpenAI HTTP backend supporting Chat Completions and native Responses. */
export class OpenAiBackend implements Backend {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #forceModel: string | undefined;
  readonly #extraHeaders: Record<string, string>;
  readonly defaultModel: string | undefined;
  readonly ports: BackendPorts;

  constructor(options: OpenAiBackendOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey ?? "not-needed";
    this.#forceModel = options.forceModel;
    this.#extraHeaders = options.headers ?? {};
    this.defaultModel = options.defaultModel;
    this.ports = {
      models: staticBackendModelPort(this.defaultModel),
      responses: {
        kind: "responses",
        supports: () => true,
        execute: async (body, signal, requestOptions) =>
          await this.responses(body, signal, requestOptions)
      },
      lifecycle: { kind: "borrowed" }
    };
  }

  #headers(options: BackendRequestOptions = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.#apiKey}`,
      ...this.#extraHeaders,
      ...(options.modelCallId ? { "x-routekit-model-call-id": options.modelCallId } : {})
    };
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    const routed =
      this.#forceModel !== undefined &&
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), model: this.#forceModel }
        : body;
    const validationError = routeKitRequestValidationErrorOf(routed);
    if (validationError !== undefined) {
      return Promise.resolve(
        invalidReasoningControlResponse(
          validationError.message,
          validationError.code === "invalid_reasoning_metadata",
          validationError.path
        )
      );
    }
    const selection = reasoningSelectionOf(routed);
    if (
      (selection.mode === "budget" || selection.mode === "adaptive") &&
      options.reasoningCapabilities?.wireShape !== "openrouter"
    ) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              message: `OpenAI Chat cannot represent reasoning mode "${selection.mode}"`
            }
          },
          { status: 400 }
        )
      );
    }
    const canonicalSelection =
      routed !== null &&
      typeof routed === "object" &&
      !Array.isArray(routed) &&
      ((routed as Record<PropertyKey, unknown>)[REASONING_SELECTION] !== undefined ||
        (routed as { x_routekit?: { selection?: unknown } }).x_routekit?.selection !== undefined);
    const selectedPayload =
      canonicalSelection && routed !== null && typeof routed === "object" && !Array.isArray(routed)
        ? {
            ...(routed as Record<string, unknown>),
            ...(selection.mode === "effort" ? { reasoning_effort: selection.effort } : {})
          }
        : routed;
    if (
      canonicalSelection &&
      selection.mode !== "effort" &&
      selectedPayload !== null &&
      typeof selectedPayload === "object" &&
      !Array.isArray(selectedPayload)
    ) {
      delete (selectedPayload as Record<string, unknown>).reasoning_effort;
    }
    const payload =
      options.reasoningCapabilities?.wireShape === "openrouter" &&
      selectedPayload !== null &&
      typeof selectedPayload === "object" &&
      !Array.isArray(selectedPayload)
        ? this.#openRouterReasoning(selectedPayload as Record<string, unknown>, selection)
        : selectedPayload;
    const providerPayload = withoutRouteKitExtensions(payload);
    return fetchViaHttpClient(joinPath(this.#baseUrl, "/chat/completions"), {
      method: "POST",
      headers: this.#headers(options),
      body: JSON.stringify(providerPayload),
      ...(signal ? { signal } : {})
    });
  }

  supportsResponses(): boolean {
    return true;
  }

  responses(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    const routed =
      this.#forceModel !== undefined &&
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), model: this.#forceModel }
        : body;
    const providerPayload = withoutRouteKitExtensions(routed);
    return fetchViaHttpClient(joinPath(this.#baseUrl, "/responses"), {
      method: "POST",
      headers: this.#headers(options),
      body: JSON.stringify(normalizeOpenAiResponsesCallIds(providerPayload)),
      ...(signal ? { signal } : {})
    });
  }

  #openRouterReasoning(
    body: Record<string, unknown>,
    selection: ReturnType<typeof reasoningSelectionOf>
  ): Record<string, unknown> {
    const payload = { ...body };
    delete payload.reasoning_effort;
    if (selection.mode === "effort") {
      payload.reasoning = { effort: selection.effort };
    } else if (selection.mode === "budget") {
      payload.reasoning = { max_tokens: selection.budgetTokens };
    } else if (selection.mode === "adaptive") {
      payload.reasoning = { enabled: true };
    } else if (selection.mode === "disabled") {
      payload.reasoning = { enabled: false };
    }
    return payload;
  }

  models(signal?: AbortSignal): Promise<Response> {
    return fetchViaHttpClient(joinPath(this.#baseUrl, "/models"), {
      method: "GET",
      headers: this.#headers(),
      ...(signal ? { signal } : {})
    });
  }

  embeddings(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    return fetchViaHttpClient(joinPath(this.#baseUrl, "/embeddings"), {
      method: "POST",
      headers: this.#headers(options),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
  }
}
