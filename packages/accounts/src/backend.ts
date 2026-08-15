import { randomUUID } from "node:crypto";

import type { ModelReasoningCapabilities } from "@velum-labs/routekit-contracts";
import type { DiscoveredProviderModel } from "@velum-labs/routekit-contracts/provider-discovery";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { subscriptionInfo } from "@velum-labs/routekit-registry";
import {
  executeWebRequest,
  type RouteKitPlatform,
  routeKitError
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { SubscriptionAccountSet } from "./account-set.js";
import { subscriptionProvider } from "./provider.js";
import type {
  SubscriptionBackendRequestOptions,
  SubscriptionProviderBackend,
  SubscriptionProviderBackendFactory,
  SubscriptionProviderTransport
} from "./provider-port.js";

export type {
  SubscriptionProviderBackendFactory,
  SubscriptionProviderBackendOptions
} from "./provider-port.js";

export type SubscriptionProviderSource = {
  readonly sourceId: SubscriptionMode;
  readonly discovery: {
    discoverModels(
      signal?: AbortSignal
    ): Effect.Effect<readonly DiscoveredProviderModel[], Error, RouteKitPlatform>;
  };
  readonly requests: {
    chat(
      body: unknown,
      signal?: AbortSignal,
      options?: SubscriptionBackendRequestOptions
    ): Effect.Effect<Response, Error, RouteKitPlatform>;
    embeddings(
      body: unknown,
      signal?: AbortSignal,
      options?: SubscriptionBackendRequestOptions
    ): Effect.Effect<Response, Error, RouteKitPlatform>;
  };
  readonly responses: { readonly kind: "unsupported" };
  readonly capabilities: {
    forModel(model: string): Readonly<Record<string, string>>;
    reasoningForModel(model: string): ModelReasoningCapabilities | undefined;
  };
  readonly resource: { readonly kind: "borrowed" };
};

export type SubscriptionAccountBackendOptions = {
  accountSet: SubscriptionAccountSet;
  model?: string;
  backendFactory: SubscriptionProviderBackendFactory;
};

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function modelFromRequest(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { model?: unknown }).model === "string"
      ? (parsed as { model: string }).model
      : undefined;
  } catch {
    return undefined;
  }
}

function claudeSubscriptionMessages(
  messages: readonly unknown[],
  spoofSystemPrompt: string
): unknown[] {
  return [
    { role: "system", content: spoofSystemPrompt },
    ...messages.flatMap((message) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        return [message];
      }
      const record = message as Record<string, unknown>;
      if (record.role !== "system" && record.role !== "developer") return [message];
      if (record.content === spoofSystemPrompt) return [];
      // Claude subscription OAuth accepts only Claude Code's identity prompt in
      // the Anthropic `system` field. Preserve caller instructions in the
      // conversation instead of triggering its generic 429 compatibility guard.
      return [{ ...record, role: "user" }];
    })
  ];
}

function withSubscriptionInstructions(
  mode: SubscriptionMode,
  body: unknown
): Record<string, unknown> {
  const input = bodyRecord(body);
  const info = subscriptionInfo(mode);
  const instructions = mode === "claude-code" ? info.spoofSystemPrompt : info.defaultInstructions;
  if (instructions === undefined || instructions.length === 0) return input;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  return {
    ...input,
    messages:
      mode === "claude-code"
        ? claudeSubscriptionMessages(messages, instructions)
        : [{ role: "system", content: instructions }, ...messages]
  };
}

function backendBaseUrl(mode: SubscriptionMode): string {
  const provider = subscriptionProvider(mode);
  return mode === "claude-code"
    ? `${provider.upstreamBaseUrl.replace(/\/$/, "")}/v1`
    : provider.upstreamBaseUrl;
}

/**
 * OpenAI Chat Completions backend backed by a RouteKit subscription pool.
 *
 * The provider-native backend performs wire translation while this wrapper
 * selects and authenticates an account for each request.
 */
export class SubscriptionAccountBackend implements SubscriptionProviderSource {
  readonly sourceId: SubscriptionMode;
  readonly defaultModel: string | undefined;
  readonly discovery: SubscriptionProviderSource["discovery"];
  readonly requests: SubscriptionProviderSource["requests"];
  readonly responses = { kind: "unsupported" as const };
  readonly capabilities: SubscriptionProviderSource["capabilities"];
  readonly resource = { kind: "borrowed" as const };
  readonly #accountSet: SubscriptionAccountSet;
  readonly #backend: SubscriptionProviderBackend;

  constructor(options: SubscriptionAccountBackendOptions) {
    this.defaultModel = options.model;
    this.#accountSet = options.accountSet;
    const mode = options.accountSet.mode;
    this.sourceId = mode;
    const provider = subscriptionProvider(mode);
    const transport: SubscriptionProviderTransport = (url, init, requestOptions) =>
      this.#accountSet.execute(
        modelFromRequest(init.body),
        (credential) => {
          const headers = new Headers(init.headers);
          headers.delete("x-api-key");
          for (const [name, value] of Object.entries(provider.authHeaders(credential))) {
            headers.set(name, value);
          }
          return executeWebRequest(url, { ...init, headers }).pipe(
            Effect.mapError((error) => routeKitError(error))
          );
        },
        init.signal ?? undefined,
        {
          responseMode: requestOptions?.responseMode,
          onAttempt: (account) =>
            requestOptions?.onAttribution?.({
              accountAttempt: {
                operationId:
                  requestOptions.attributionOperationId ??
                  requestOptions.modelCallId ??
                  randomUUID(),
                seat: account.seat
              }
            })
        }
      );
    const backendOptions = {
      baseUrl: backendBaseUrl(mode),
      apiKey: "",
      ...(mode === "codex" ? { forceStream: true, omitSampling: true } : {}),
      ...(this.defaultModel !== undefined ? { defaultModel: this.defaultModel } : {}),
      transport
    };
    this.#backend = options.backendFactory(mode, backendOptions);
    this.discovery = {
      discoverModels: (signal) => this.#discoverModels(signal)
    };
    this.requests = {
      chat: (body, signal, requestOptions) => this.#chat(body, signal, requestOptions),
      embeddings: (body, signal, requestOptions) =>
        this.#backend.embeddings(body, signal, requestOptions)
    };
    this.capabilities = {
      forModel: (model) => this.#capabilities(model),
      reasoningForModel: (model) => this.#accountSet.reasoningCapabilities(model)
    };
  }

  listModelIds(): readonly string[] {
    return this.defaultModel === undefined ? this.#accountSet.listModelIds() : [this.defaultModel];
  }

  servesModel(model: string): boolean {
    return this.listModelIds().includes(model);
  }

  resolveModel(requested: string | undefined): string | undefined {
    if (requested === undefined) return this.defaultModel ?? this.listModelIds()[0];
    return this.servesModel(requested) ? requested : undefined;
  }

  #capabilities(_model?: string): Readonly<Record<string, string>> {
    return {
      streaming: "supported",
      tools: "supported"
    };
  }

  reasoningWireShape(model: string): string | undefined {
    const delegatedModel =
      this.#backend.resolveModel?.(model) ?? this.#backend.defaultModel ?? model;
    return this.#backend.reasoningWireShape?.(delegatedModel);
  }

  #discoverModels(signal?: AbortSignal) {
    const self = this;
    return Effect.gen(function* () {
      const models = yield* self.#accountSet.discoverModels(signal);
      return models.map((id) => {
        const selection = self.#accountSet.modelSelectionSignals(id);
        return {
          id,
          capabilities: self.#capabilities(id),
          ...(selection?.createdAt !== undefined ? { createdAt: selection.createdAt } : {}),
          ...(selection?.providerPriority !== undefined
            ? { providerPriority: selection.providerPriority }
            : {}),
          ...(self.#accountSet.modelMetadata(id) !== undefined
            ? { metadata: self.#accountSet.modelMetadata(id) }
            : {}),
          ...(self.#accountSet.reasoningCapabilities(id) !== undefined
            ? { reasoning: self.#accountSet.reasoningCapabilities(id) }
            : {})
        };
      });
    });
  }

  #chat(
    body: unknown,
    signal?: AbortSignal,
    options?: SubscriptionBackendRequestOptions
  ): Effect.Effect<Response, Error, RouteKitPlatform> {
    const attributedOptions = {
      ...options,
      attributionOperationId: randomUUID()
    };
    return this.#backend.chat(
      withSubscriptionInstructions(this.#accountSet.mode, body),
      signal,
      attributedOptions
    );
  }

  models(signal?: AbortSignal): Effect.Effect<Response, Error, RouteKitPlatform> {
    return this.#backend.models(signal);
  }
}
