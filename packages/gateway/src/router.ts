import {
  configuredProviderIds,
  parseRouterConfig,
  type RouterConfig
} from "@velum-labs/routekit-config-core";
import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ModelSelectionSignals,
  ReasoningSelection
} from "@velum-labs/routekit-contracts";
import { resolveReasoningSelection } from "@velum-labs/routekit-contracts";
import {
  EffectResourceScope,
  RouteKitFailure,
  routeKitError
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import {
  anthropicRequestMetadataOf,
  attachAnthropicRequestMetadata,
  attachReasoningSelection,
  reasoningSelectionOf,
  routeKitRequestValidationErrorOf
} from "./adapters/openai-chat-wire.js";
import type {
  Backend,
  BackendModelRoute,
  BackendPorts,
  BackendRequest,
  BackendRequestOptions
} from "./backend.js";
import { BedrockProviderSource } from "./bedrock-source.js";
import { gatewayTry, gatewayTryPromise } from "./effect/gateway.js";
import type {
  ApiProviderId,
  DiscoveredModel,
  ProviderId,
  ProviderSource
} from "./provider-source.js";
import {
  API_PROVIDER_IDS,
  ApiProviderSource,
  SUBSCRIPTION_PROVIDER_IDS
} from "./provider-source.js";
import type { ModelCatalogEntry, RoutePlan } from "./routing-core.js";
import {
  BackendExecutor,
  ModelCatalog,
  ModelResolver,
  ProviderLifecycle,
  RoutePlanner,
  RoutePolicy
} from "./routing-core.js";

export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(`unknown model: ${model}`);
    this.name = "UnknownModelError";
  }
}

export class NoModelAvailableError extends Error {
  constructor() {
    super("no model is available; configure a provider");
    this.name = "NoModelAvailableError";
  }
}

export type CatalogModelInfo = ModelSelectionSignals & {
  id: string;
  provider: ProviderId;
  nativeModel: string;
  accountClass: "api-key" | "subscription" | "proxy";
  billingMode: "metered-api" | "subscription" | "upstream-managed";
  default: boolean;
  capabilities: Readonly<Record<string, string>>;
  metadata?: ModelCapabilityMetadata;
  reasoning: ModelReasoningCapabilities | null;
};

function routeBilling(
  provider: ProviderId
): Pick<CatalogModelInfo, "accountClass" | "billingMode"> {
  switch (provider) {
    case "openai":
    case "anthropic":
    case "bedrock":
    case "google":
    case "openrouter":
      return { accountClass: "api-key", billingMode: "metered-api" };
    case "codex":
    case "claude-code":
      return { accountClass: "subscription", billingMode: "subscription" };
    case "cliproxy":
      return { accountClass: "proxy", billingMode: "upstream-managed" };
    default: {
      const unreachable: never = provider;
      throw new Error(`unsupported route provider: ${String(unreachable)}`);
    }
  }
}

export type RoutingBackendOptions = {
  config: RouterConfig | unknown;
  env?: Readonly<Record<string, string | undefined>>;
  sources?: Partial<Record<ProviderId, ProviderSource>>;
  createApiSource?: (
    provider: ApiProviderId,
    env: Readonly<Record<string, string | undefined>>
  ) => ProviderSource;
  signal?: AbortSignal;
};

function isApiProvider(provider: ProviderId): provider is ApiProviderId {
  return API_PROVIDER_IDS.includes(provider as ApiProviderId);
}

function namespaced(provider: ProviderId, model: string): string {
  return model === provider || model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

/** Match an anchored model-policy glob where only `*` has special meaning. */
export function modelPolicyRuleMatches(rule: string, canonicalModel: string): boolean {
  const literals = rule.split("*");
  if (literals.length === 1) return canonicalModel === rule;
  let offset = 0;
  if (!canonicalModel.startsWith(literals[0] ?? "")) return false;
  offset = (literals[0] ?? "").length;
  for (let index = 1; index < literals.length - 1; index += 1) {
    const literal = literals[index] ?? "";
    const found = canonicalModel.indexOf(literal, offset);
    if (found < 0) return false;
    offset = found + literal.length;
  }
  const suffix = literals.at(-1) ?? "";
  return canonicalModel.slice(offset).endsWith(suffix);
}

/** Apply inclusive allowlist then denylist; a matching deny rule always wins. */
export function modelPolicyAllowsModel(
  policy: RouterConfig["modelPolicy"],
  canonicalModel: string
): boolean {
  const allowed =
    policy?.allow === undefined ||
    policy.allow.length === 0 ||
    policy.allow.some((rule) => modelPolicyRuleMatches(rule, canonicalModel));
  return (
    allowed && !(policy?.deny ?? []).some((rule) => modelPolicyRuleMatches(rule, canonicalModel))
  );
}

export class RoutingBackend implements Backend {
  readonly ports: BackendPorts;
  readonly defaultModel: string | undefined;
  readonly catalog: ModelCatalog;
  readonly resolver: ModelResolver;
  readonly planner: RoutePlanner;
  readonly executor: BackendExecutor;
  readonly providers: ProviderLifecycle;

  private constructor(
    defaultModel: string | undefined,
    catalog: ModelCatalog,
    sources: readonly ProviderSource[]
  ) {
    this.defaultModel = defaultModel;
    this.catalog = catalog;
    this.resolver = new ModelResolver(catalog, defaultModel);
    this.planner = new RoutePlanner(this.resolver);
    this.executor = new BackendExecutor(sources);
    this.providers = new ProviderLifecycle(sources);
    this.ports = {
      models: {
        kind: "model-catalog",
        list: () => this.listModelIds(),
        resolve: (requested) => this.resolveModel(requested),
        resolveRoute: (requested, nativeProvider) =>
          this.resolveModelRoute(requested, nativeProvider),
        serves: (model) => this.servesModel(model),
        capabilities: (model) => this.capabilities(model),
        metadata: (model) => this.modelMetadata(model),
        reasoning: (model) => this.reasoningCapabilities(model),
        reasoningWireShape: (model) => this.reasoningWireShape(model)
      },
      responses: {
        kind: "responses",
        supports: (model) => this.supportsResponses(model),
        execute: (body, signal, options) => this.responses(body, signal, options)
      },
      lifecycle: { kind: "owned", close: this.close() }
    };
  }

  static create(options: RoutingBackendOptions) {
    return Effect.gen(function* () {
      const config = yield* gatewayTry(() => parseRouterConfig(options.config));
      const env = options.env ?? process.env;
      const startup = new EffectResourceScope();
      const sources: ProviderSource[] = [];
      const entries = new Map<string, ModelCatalogEntry>();
      const discoveredIds = new Set<string>();
      return yield* Effect.gen(function* () {
        for (const provider of configuredProviderIds(config)) {
          const injected = options.sources?.[provider];
          const source = yield* gatewayTry(() => {
            if (injected !== undefined) return injected;
            if (provider === "bedrock") return new BedrockProviderSource();
            if (isApiProvider(provider)) {
              return (
                options.createApiSource?.(provider, env) ?? new ApiProviderSource({ provider, env })
              );
            }
            throw new RouteKitFailure({
              message: `provider "${provider}" requires enrolled subscription accounts`
            });
          });
          if (source.sourceId !== provider) {
            return yield* new RouteKitFailure({
              message: `provider source mismatch: configured "${provider}", received "${source.sourceId}"`
            });
          }
          sources.push(source);
          yield* startup.own(source, {
            finalizeEffect: (ownedSource) =>
              ownedSource.resource.kind === "owned" ? ownedSource.resource.close : Effect.void
          });
          const discovered = yield* source.discovery.discoverModels(options.signal).pipe(
            Effect.mapError(
              (error) =>
                new RouteKitFailure({
                  message: `provider "${provider}" discovery failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                  cause: error
                })
            )
          );
          if (discovered.length === 0) {
            return yield* new RouteKitFailure({
              message: `provider "${provider}" discovery returned no models`
            });
          }
          for (const model of discovered) {
            const publicId = namespaced(provider, model.id);
            discoveredIds.add(publicId);
            if (
              !new RoutePolicy((modelId) =>
                modelPolicyAllowsModel(config.modelPolicy, modelId)
              ).admit(publicId)
            ) {
              continue;
            }
            if (entries.has(publicId)) continue;
            const override = config.reasoningCapabilities?.[publicId];
            const reasoning =
              override !== undefined
                ? {
                    ...override,
                    provenance: "config" as const
                  }
                : (model.reasoning ?? source.capabilities.reasoningForModel(model.id));
            entries.set(publicId, {
              publicId,
              nativeId: model.id,
              provider,
              capabilities: model.capabilities ?? source.capabilities.forModel(model.id),
              ...(model.createdAt !== undefined ? { createdAt: model.createdAt } : {}),
              ...(model.providerPriority !== undefined
                ? { providerPriority: model.providerPriority }
                : {}),
              ...(model.metadata !== undefined ? { metadata: model.metadata } : {}),
              ...(reasoning !== undefined ? { reasoning } : {})
            });
          }
        }
        const backend = yield* gatewayTry(() => {
          for (const [alias, target] of Object.entries(config.modelAliases ?? {})) {
            const entry = entries.get(target);
            if (entry === undefined) {
              if (discoveredIds.has(target)) {
                throw new RouteKitFailure({
                  message: `model alias "${alias}" targets "${target}", which is excluded by model policy`
                });
              }
              throw new RouteKitFailure({
                message: `model alias "${alias}" targets "${target}", which no configured provider serves`
              });
            }
            if (entries.has(alias)) {
              throw new RouteKitFailure({
                message: `model alias "${alias}" collides with a served model id`
              });
            }
            entries.set(alias, { ...entry, publicId: alias });
          }
          if (
            config.defaultModel !== undefined &&
            !entries.has(config.defaultModel) &&
            discoveredIds.has(config.defaultModel)
          ) {
            throw new RouteKitFailure({
              message: `default model "${config.defaultModel}" is excluded by model policy`
            });
          }
          const first = entries.keys().next().value as string | undefined;
          const defaultModel = config.defaultModel ?? first;
          if (defaultModel === undefined) {
            if (discoveredIds.size > 0) {
              throw new RouteKitFailure({
                message: "model policy excludes all discovered models"
              });
            }
            if (configuredProviderIds(config).length > 0) {
              throw new RouteKitFailure({
                message: "configured providers discovered no models"
              });
            }
          } else if (!entries.has(defaultModel)) {
            throw new UnknownModelError(defaultModel);
          }
          return new RoutingBackend(defaultModel, new ModelCatalog(entries), sources);
        });
        yield* startup.releaseAll();
        return backend;
      }).pipe(
        Effect.catch((error) =>
          startup.dispose().pipe(
            Effect.matchEffect({
              onFailure: (cleanupError) => {
                const unwrapped = routeKitError(cleanupError);
                const cleanupErrors =
                  unwrapped instanceof AggregateError ? unwrapped.errors : [unwrapped];
                return Effect.fail(
                  new AggregateError(
                    [error instanceof Error ? error : routeKitError(error), ...cleanupErrors],
                    "routing backend startup failed and provider cleanup was incomplete"
                  )
                );
              },
              onSuccess: () => Effect.fail(error instanceof Error ? error : routeKitError(error))
            })
          )
        )
      );
    });
  }

  listModelIds(): readonly string[] {
    return this.catalog.ids();
  }

  modelInfo(model: string): CatalogModelInfo | undefined {
    const entry = this.catalog.get(model);
    if (entry === undefined) return undefined;
    return {
      id: entry.publicId,
      provider: entry.provider,
      nativeModel: entry.nativeId,
      ...routeBilling(entry.provider),
      default: entry.publicId === this.defaultModel,
      capabilities: entry.capabilities,
      ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
      ...(entry.providerPriority !== undefined ? { providerPriority: entry.providerPriority } : {}),
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      reasoning: entry.reasoning ?? null
    };
  }

  providerStatuses(signal?: AbortSignal) {
    return this.providers.statuses(this.catalog, signal);
  }

  servesModel(model: string): boolean {
    return this.catalog.get(model) !== undefined;
  }

  resolveModel(requested: string | undefined): string | undefined {
    if (requested === undefined) return this.defaultModel;
    return this.catalog.get(requested) !== undefined ? requested : undefined;
  }

  resolveModelRoute(
    requested: string | undefined,
    nativeProvider?: string
  ): BackendModelRoute | undefined {
    const publicId = requested ?? this.defaultModel;
    if (publicId === undefined) return undefined;
    const plan = this.planner.plan(publicId, nativeProvider);
    return plan === undefined ? undefined : this.#modelRoute(plan);
  }

  capabilities(model: string): Readonly<Record<string, string>> {
    return this.catalog.get(model)?.capabilities ?? {};
  }

  modelMetadata(model: string): ModelCapabilityMetadata | undefined {
    return this.catalog.get(model)?.metadata;
  }

  reasoningCapabilities(model: string): ModelReasoningCapabilities | undefined {
    return this.catalog.get(model)?.reasoning;
  }

  reasoningWireShape(model: string): string | undefined {
    const entry = this.catalog.get(model);
    if (entry === undefined) return undefined;
    // Protocol identity is stronger than optional model capability metadata:
    // Codex sources always egress through Responses even when discovery omits
    // reasoning controls for a particular model.
    return entry.provider === "codex" ? "openai-responses" : entry.reasoning?.wireShape;
  }

  supportsResponses(model: string): boolean {
    const entry = this.catalog.get(model);
    if (entry === undefined) return false;
    return this.executor.supportsResponses(this.#plan(entry));
  }

  chat(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest {
    const entry = this.#entry(this.#requestedModel(body));
    const validationError = routeKitRequestValidationErrorOf(body);
    if (validationError !== undefined) {
      return Effect.succeed(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              code: validationError.code,
              param: validationError.path,
              message: validationError.message
            }
          },
          { status: 400 }
        )
      );
    }
    const requestedSelection = reasoningSelectionOf(body);
    const anthropicMetadata = anthropicRequestMetadataOf(body);
    const allowProviderOpaqueEffort =
      entry.provider === "claude-code" &&
      requestedSelection.mode === "effort" &&
      anthropicMetadata?.output_config?.effort === requestedSelection.effort;
    const selection = this.#validatedReasoning(
      entry,
      requestedSelection,
      allowProviderOpaqueEffort
    );
    if (typeof selection === "string") {
      return Effect.succeed(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              code: "unsupported_reasoning_control",
              message: selection
            }
          },
          { status: 400 }
        )
      );
    }
    const nativeBody = this.#withNativeModel(body, entry.nativeId);
    options?.onAttribution?.({
      effective_model: entry.publicId,
      native_model: entry.nativeId,
      provider: entry.provider,
      billing_mode:
        isSubscriptionProvider(entry.provider) || entry.provider === "cliproxy"
          ? "subscription"
          : "api_key"
    });
    if (nativeBody !== null && typeof nativeBody === "object" && !Array.isArray(nativeBody)) {
      const egressSelection =
        requestedSelection.mode === "effort" &&
        requestedSelection.effort === "none" &&
        selection.mode === "disabled"
          ? ({ mode: "auto" } as const)
          : selection;
      attachReasoningSelection(nativeBody as Record<PropertyKey, unknown>, egressSelection);
      if (selection.mode === "effort") {
        (nativeBody as Record<string, unknown>).reasoning_effort = selection.effort;
        if (anthropicMetadata !== undefined) {
          attachAnthropicRequestMetadata(nativeBody as Record<PropertyKey, unknown>, {
            ...anthropicMetadata,
            output_config: {
              ...anthropicMetadata.output_config,
              effort: selection.effort
            }
          });
        }
      } else {
        delete (nativeBody as Record<string, unknown>).reasoning_effort;
      }
    }
    return this.executor.chat(this.#plan(entry), nativeBody, signal, {
      ...options,
      ...(entry.reasoning !== undefined ? { reasoningCapabilities: entry.reasoning } : {})
    });
  }

  responses(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest {
    const entry = this.#entry(this.#requestedModel(body));
    if (!this.executor.supportsResponses(this.#plan(entry))) {
      return Effect.succeed(
        Response.json(
          { error: { type: "not_supported", message: "native Responses egress is not supported" } },
          { status: 501 }
        )
      );
    }
    const validationError = routeKitRequestValidationErrorOf(body);
    if (validationError !== undefined) {
      return Effect.succeed(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              code: validationError.code,
              param: validationError.path,
              message: validationError.message
            }
          },
          { status: 400 }
        )
      );
    }
    const record =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const nativeReasoning =
      typeof record.reasoning === "object" &&
      record.reasoning !== null &&
      !Array.isArray(record.reasoning)
        ? (record.reasoning as Record<string, unknown>)
        : undefined;
    const nativeEffort =
      typeof nativeReasoning?.effort === "string" && nativeReasoning.effort.length > 0
        ? nativeReasoning.effort
        : undefined;
    const envelopeSelection = reasoningSelectionOf(body);
    if (
      nativeEffort !== undefined &&
      envelopeSelection.mode !== "auto" &&
      (envelopeSelection.mode !== "effort" || envelopeSelection.effort !== nativeEffort)
    ) {
      return Effect.succeed(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              code: "invalid_reasoning_control",
              param: "reasoning",
              message: "reasoning.effort conflicts with x_routekit.selection"
            }
          },
          { status: 400 }
        )
      );
    }
    const requestedSelection: ReasoningSelection =
      envelopeSelection.mode === "auto" && nativeEffort !== undefined
        ? { mode: "effort", effort: nativeEffort }
        : envelopeSelection;
    const selection = this.#validatedReasoning(entry, requestedSelection);
    if (typeof selection === "string") {
      return Effect.succeed(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              code: "unsupported_reasoning_control",
              message: selection
            }
          },
          { status: 400 }
        )
      );
    }
    const nativeBody = this.#withNativeModel(record, entry.nativeId) as Record<string, unknown>;
    if (selection.mode === "effort") {
      nativeBody.reasoning = { ...nativeReasoning, effort: selection.effort };
    } else if (selection.mode === "disabled") {
      nativeBody.reasoning = { ...nativeReasoning, effort: "none" };
    }
    options?.onAttribution?.({
      effective_model: entry.publicId,
      native_model: entry.nativeId,
      provider: entry.provider,
      billing_mode:
        isSubscriptionProvider(entry.provider) || entry.provider === "cliproxy"
          ? "subscription"
          : "api_key"
    });
    return this.executor.responses(this.#plan(entry), nativeBody, signal, {
      ...options,
      ...(entry.reasoning !== undefined ? { reasoningCapabilities: entry.reasoning } : {})
    });
  }

  models(): BackendRequest {
    const data = this.catalog.entries().map((entry) => {
      const architecture = entry.metadata?.architecture;
      return {
        id: entry.publicId,
        object: "model",
        owned_by: entry.provider,
        capabilities: entry.capabilities,
        ...(entry.createdAt !== undefined ? { created: entry.createdAt } : {}),
        ...(entry.providerPriority !== undefined
          ? { routekit_provider_priority: entry.providerPriority }
          : {}),
        ...(architecture !== undefined
          ? {
              architecture: {
                ...(architecture.modality !== undefined ? { modality: architecture.modality } : {}),
                input_modalities: architecture.inputModalities,
                output_modalities: architecture.outputModalities
              }
            }
          : {}),
        ...(entry.metadata?.supportedParameters !== undefined
          ? { supported_parameters: entry.metadata.supportedParameters }
          : {}),
        ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {})
      };
    });
    return Effect.succeed(
      new Response(JSON.stringify({ object: "list", data }), {
        headers: { "content-type": "application/json" }
      })
    );
  }

  embeddings(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest {
    const entry = this.#entry(this.#requestedModel(body));
    options?.onAttribution?.({
      effective_model: entry.publicId,
      native_model: entry.nativeId,
      provider: entry.provider,
      billing_mode:
        isSubscriptionProvider(entry.provider) || entry.provider === "cliproxy"
          ? "subscription"
          : "api_key"
    });
    return this.executor.embeddings(
      this.#plan(entry),
      this.#withNativeModel(body, entry.nativeId),
      signal,
      options
    );
  }

  close() {
    return this.providers.close();
  }

  #requestedModel(body: unknown): string | undefined {
    return typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      typeof (body as { model?: unknown }).model === "string"
      ? (body as { model: string }).model
      : undefined;
  }

  #entry(requested: string | undefined): ModelCatalogEntry {
    const model = requested ?? this.defaultModel;
    if (model === undefined) throw new NoModelAvailableError();
    const entry = this.catalog.get(model);
    if (entry === undefined) throw new UnknownModelError(model);
    return entry;
  }

  #withNativeModel(body: unknown, nativeModel: string): unknown {
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), model: nativeModel }
      : body;
  }

  #modelRoute(entry: ModelCatalogEntry | RoutePlan): BackendModelRoute {
    return {
      publicId: "publicId" in entry ? entry.publicId : entry.publicModel,
      nativeId: "nativeId" in entry ? entry.nativeId : entry.nativeModel,
      provider: entry.provider,
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {})
    };
  }

  #plan(entry: ModelCatalogEntry): RoutePlan {
    const plan = this.planner.plan(entry.publicId);
    if (plan === undefined) throw new UnknownModelError(entry.publicId);
    return plan;
  }

  #validatedReasoning(
    entry: ModelCatalogEntry,
    selection: ReasoningSelection,
    allowProviderOpaqueEffort = false
  ): ReasoningSelection | string {
    const capability = entry.reasoning;
    if (
      selection.mode === "effort" &&
      selection.effort === "none" &&
      (capability === undefined ||
        capability.status === "unknown" ||
        capability.status === "unsupported")
    ) {
      return { mode: "disabled" };
    }
    const resolved = resolveReasoningSelection(capability, selection);
    if (resolved.ok) return resolved.selection;
    if (resolved.code === "unknown_capability") {
      return `model "${entry.publicId}" has no discovered reasoning controls`;
    }
    if (resolved.code === "unsupported") {
      return `model "${entry.publicId}" does not support reasoning controls`;
    }
    if (resolved.code === "unsupported_effort") {
      if (allowProviderOpaqueEffort) return selection;
      return `reasoning effort "${selection.mode === "effort" ? selection.effort : ""}" is not supported by model "${entry.publicId}"`;
    }
    if (resolved.code === "unsupported_adaptive") {
      return `adaptive reasoning is not supported by model "${entry.publicId}"`;
    }
    if (resolved.code === "unsupported_budget") {
      return `reasoning token budgets are not supported by model "${entry.publicId}"`;
    }
    return resolved.message;
  }
}

export function isSubscriptionProvider(
  provider: ProviderId
): provider is (typeof SUBSCRIPTION_PROVIDER_IDS)[number] {
  return SUBSCRIPTION_PROVIDER_IDS.includes(provider as (typeof SUBSCRIPTION_PROVIDER_IDS)[number]);
}
