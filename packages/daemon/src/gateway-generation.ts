import type {
  RedeemResetCreditResult,
  ResetCreditSnapshot,
  SubscriptionAccountConfigs,
  SubscriptionAccountSet,
  SubscriptionAccountSetSnapshot,
  SubscriptionUsageResponse
} from "@velum-labs/routekit-accounts";
import {
  CLIPROXY_API_KEY_ENV,
  cliproxyApiKey,
  closeSubscriptionAccountSets,
  collectSubscriptionUsage,
  defaultSubscriptionAccountDirectory,
  defaultSubscriptionCredentialPath,
  openSubscriptionAccountSets,
  SubscriptionAccountBackend,
  snapshotsToUsage,
  subscriptionRelaysFromAccountSets
} from "@velum-labs/routekit-accounts";
import type {
  AccountActivityService,
  AccountAuthService
} from "@velum-labs/routekit-accounts/effect";
import {
  DEFAULT_CLASSIFIER_MODEL,
  type ProviderId,
  type RouterConfig,
  resolveCompositionalRoutingConfig
} from "@velum-labs/routekit-config";
import type {
  CatalogModelInfo,
  CompositionalRoutingObservation,
  CompositionalRoutingPolicyReader,
  Gateway,
  ProvenanceSink,
  ProviderSource,
  RequestDecomposerService
} from "@velum-labs/routekit-gateway";
import {
  AnthropicBackend,
  ClassificationError,
  CodexResponsesBackend,
  invokeObservedModelCall,
  makeLanguageModelDimensionClassifier,
  RoutingBackend,
  routingModelAvailability
} from "@velum-labs/routekit-gateway";
import { startGatewayEffect } from "@velum-labs/routekit-gateway/effect";
import {
  RouteKitFailure,
  type RouteKitPlatform,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { assertAuthenticatedBind } from "@velum-labs/routekit-runtime/network";
import { Cause, Context, Effect, Exit, Scope } from "effect";

export type GatewayGenerationOptions = {
  config: RouterConfig;
  host?: string;
  port?: number;
  authToken?: string;
  env?: NodeJS.ProcessEnv;
  sources?: Partial<Record<ProviderId, ProviderSource>>;
  provenance?: ProvenanceSink;
  /** Published model-by-dimension evidence used by automatic routing. */
  compositionalPolicyReader?: CompositionalRoutingPolicyReader;
  /** Override the default small-LM semantic dimension classifier. */
  requestDecomposer?: RequestDecomposerService;
  /** Receives sanitized automatic-routing decisions and failures. */
  onCompositionalRoutingObservation?(observation: CompositionalRoutingObservation): void;
  /**
   * Daemon-owned activity coordinator shared across router generations.
   * Standalone routers create a private coordinator when omitted.
   */
  activity?: AccountActivityService;
  /** Daemon-owned upstream-auth coordinator shared across router generations. */
  authHealth?: AccountAuthService;
  /**
   * Graceful-drain window applied on SIGINT/SIGTERM: in-flight requests
   * (long-lived LLM streams) get up to this long to finish before the
   * listener is severed. 0 (the default) preserves immediate shutdown for
   * embedded and interactive uses; service processes pass a real grace.
   */
  drainGraceMs?: number;
};

export type GatewayGenerationRedeemResetOptions = {
  kind: "codex";
  label: string;
  creditId?: string;
  redeemRequestId?: string;
};

function subscriptionBackendFor(
  kind: "claude-code" | "codex",
  accountSet: SubscriptionAccountSet
): SubscriptionAccountBackend {
  switch (kind) {
    case "claude-code":
      return new SubscriptionAccountBackend({
        accountSet,
        backendFactory: (_mode, backendOptions) => new AnthropicBackend(backendOptions)
      });
    case "codex":
      return new SubscriptionAccountBackend({
        accountSet,
        backendFactory: (_mode, backendOptions) => new CodexResponsesBackend(backendOptions)
      });
    default: {
      const unreachable: never = kind;
      throw new Error(`unsupported subscription provider: ${String(unreachable)}`);
    }
  }
}

export type GatewayGenerationRedeemResetResponse = RedeemResetCreditResult & {
  usage: SubscriptionUsageResponse;
};

export type RunningGatewayGeneration = {
  gateway: Gateway;
  url: string;
  readonly close: Effect.Effect<void, unknown, RouteKitPlatform>;
  providerStatuses(signal?: AbortSignal): ReturnType<RoutingBackend["providerStatuses"]>;
  modelCatalog(): readonly CatalogModelInfo[];
  modelInfo(model: string): ReturnType<RoutingBackend["modelInfo"]>;
  accountSnapshots(): SubscriptionAccountSetSnapshot[];
  usage(signal?: AbortSignal): Effect.Effect<SubscriptionUsageResponse, Error, RouteKitPlatform>;
  listResetCredits(
    kind: "codex",
    label: string,
    signal?: AbortSignal
  ): Effect.Effect<ResetCreditSnapshot, Error, RouteKitPlatform>;
  redeemReset(
    input: GatewayGenerationRedeemResetOptions,
    signal?: AbortSignal
  ): Effect.Effect<GatewayGenerationRedeemResetResponse, Error, RouteKitPlatform>;
};

type AcquiredGatewayGeneration = Omit<RunningGatewayGeneration, "close">;

function addOwnedFinalizer(
  scope: Scope.Closeable,
  platform: Context.Context<RouteKitPlatform>,
  closeErrors: unknown[],
  finalizer: Effect.Effect<void, unknown, RouteKitPlatform>
): Effect.Effect<void> {
  return Scope.addFinalizer(
    scope,
    Effect.exit(finalizer.pipe(Effect.provide(platform))).pipe(
      Effect.flatMap((closed) =>
        Exit.isFailure(closed)
          ? Effect.sync(() => {
              closeErrors.push(Cause.squash(closed.cause));
            })
          : Effect.void
      )
    )
  );
}

function closeError(closeErrors: readonly unknown[], message: string): Error | undefined {
  if (closeErrors.length === 0) return undefined;
  return closeErrors.length === 1
    ? toRouteKitFailure(closeErrors[0])
    : new AggregateError(closeErrors, message);
}

function gatewayEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved = { ...env };
  if (resolved[CLIPROXY_API_KEY_ENV] === undefined) {
    const managed = cliproxyApiKey(env);
    if (managed !== undefined) resolved[CLIPROXY_API_KEY_ENV] = managed;
  }
  return resolved;
}

function accountConfigs(config: RouterConfig, env: NodeJS.ProcessEnv): SubscriptionAccountConfigs {
  const configured = config.providers;
  // Do not inspect or auto-import unrelated local subscription credentials
  // when an embedded router only configures API-key providers.
  const accounts: SubscriptionAccountConfigs = {};
  const claude = configured["claude-code"];
  if (claude !== undefined) {
    accounts["claude-code"] = {
      source: {
        kind: "auto",
        directory: defaultSubscriptionAccountDirectory("claude-code", env),
        canonicalPath: defaultSubscriptionCredentialPath("claude-code", env)
      },
      strategy: claude.strategy,
      switchThreshold: claude.switchThreshold,
      ...(claude.probeIntervalMs !== undefined ? { probeIntervalMs: claude.probeIntervalMs } : {}),
      ...(claude.fallbackCooldownSeconds !== undefined
        ? { fallbackCooldownSeconds: claude.fallbackCooldownSeconds }
        : {})
    };
  }
  const codex = configured.codex;
  if (codex !== undefined) {
    accounts.codex = {
      source: {
        kind: "auto",
        directory: defaultSubscriptionAccountDirectory("codex", env),
        canonicalPath: defaultSubscriptionCredentialPath("codex", env)
      },
      strategy: codex.strategy,
      switchThreshold: codex.switchThreshold,
      ...(codex.probeIntervalMs !== undefined ? { probeIntervalMs: codex.probeIntervalMs } : {}),
      ...(codex.fallbackCooldownSeconds !== undefined
        ? { fallbackCooldownSeconds: codex.fallbackCooldownSeconds }
        : {})
    };
  }
  return accounts;
}

const acquireGatewayGeneration = Effect.fn("GatewayGeneration.acquire")(function* (
  options: GatewayGenerationOptions,
  scope: Scope.Closeable,
  platform: Context.Context<RouteKitPlatform>,
  closeErrors: unknown[]
): Effect.fn.Return<AcquiredGatewayGeneration, Error, RouteKitPlatform> {
  const host = options.host ?? "127.0.0.1";
  yield* Effect.try({
    try: () => assertAuthenticatedBind(host, options.authToken),
    catch: (cause) => toRouteKitFailure(cause)
  });
  const env = options.env ?? process.env;
  const accounts = accountConfigs(options.config, env);
  const accountSets = yield* openSubscriptionAccountSets(
    accounts,
    options.activity === undefined
      ? undefined
      : { resource: options.activity, ownership: "borrowed" },
    options.authHealth === undefined
      ? undefined
      : { resource: options.authHealth, ownership: "borrowed" }
  );
  yield* addOwnedFinalizer(scope, platform, closeErrors, closeSubscriptionAccountSets(accountSets));

  const requiredKinds = new Set(
    (["claude-code", "codex"] as const).filter(
      (provider) =>
        options.config.providers[provider] !== undefined &&
        options.sources?.[provider] === undefined
    )
  );
  for (const kind of requiredKinds) {
    if ((accountSets[kind]?.size ?? 0) === 0) {
      return yield* new RouteKitFailure({
        message:
          `provider "${kind}" requires an enrolled account; ` +
          `run \`routekit accounts login ${kind} --name <label>\``
      });
    }
  }
  const relays = subscriptionRelaysFromAccountSets(
    Object.fromEntries(
      [...requiredKinds].map((kind) => [kind, accountSets[kind]])
    ) as typeof accountSets
  );
  for (const [kind, accountSet] of Object.entries(accountSets)) {
    if (accountSet.size === 0 && !requiredKinds.has(kind as "claude-code" | "codex")) {
      yield* accountSet.close();
      delete accountSets[kind as "claude-code" | "codex"];
    }
  }
  const sources: Partial<Record<ProviderId, ProviderSource>> = {
    ...options.sources
  };
  for (const kind of requiredKinds) {
    sources[kind] = subscriptionBackendFor(kind, accountSets[kind]!);
  }
  const backend = yield* RoutingBackend.create({
    config: options.config,
    env: gatewayEnvironment(env),
    sources
  });
  yield* addOwnedFinalizer(scope, platform, closeErrors, backend.close());

  const configuredClassifierModel = options.config.classifierModel;
  const classifierModel = configuredClassifierModel ?? DEFAULT_CLASSIFIER_MODEL;
  const classifierComplete = (endpointId: string) => (body: unknown) =>
    invokeObservedModelCall(options.provenance, {
      dialect: "openai-chat",
      body,
      defaultModel: backend.defaultModel,
      requestedModel: classifierModel,
      endpointId,
      invoke: (callId, signal, onAttribution) =>
        backend.chat(body, signal, {
          modelCallId: callId,
          responseMode: "buffered",
          onAttribution
        })
    }).pipe(Effect.provide(platform));
  const unavailableClassifier = () =>
    Effect.fail(
      new ClassificationError({
        message: `classifier model ${JSON.stringify(
          configuredClassifierModel ?? DEFAULT_CLASSIFIER_MODEL
        )} is unavailable; configure classifierModel to a served model`
      })
    );
  const compositionalConfig = resolveCompositionalRoutingConfig(options.config);
  const requestDecomposer =
    options.requestDecomposer ??
    (backend.ports.models.serves(classifierModel)
      ? makeLanguageModelDimensionClassifier({
          model: classifierModel,
          complete: classifierComplete("dimension-request-classifier")
        })
      : { classify: unavailableClassifier });
  const compositionalRouting = {
    policyReader: options.compositionalPolicyReader,
    classifier: requestDecomposer,
    availableModels: routingModelAvailability(backend),
    objective: compositionalConfig.objective,
    maximumUnknownWeight: compositionalConfig.maximumUnknownWeight,
    ...((compositionalConfig.minimumDimensionQuality !== undefined ||
      compositionalConfig.maximumFailureRate !== undefined) && {
      constraints: {
        ...(compositionalConfig.minimumDimensionQuality === undefined
          ? {}
          : { minimumDimensionQuality: compositionalConfig.minimumDimensionQuality }),
        ...(compositionalConfig.maximumFailureRate === undefined
          ? {}
          : { maximumFailureRate: compositionalConfig.maximumFailureRate })
      }
    }),
    ...(options.onCompositionalRoutingObservation === undefined
      ? {}
      : { onObservation: options.onCompositionalRoutingObservation })
  };
  const gateway = yield* startGatewayEffect({
    backend,
    backendOwnership: "borrowed",
    relayOwnership: "borrowed",
    host,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
    ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
    compositionalRouting,
    ...(Object.keys(relays).length > 0 ? { providerRelays: relays } : {}),
    usage: () =>
      collectSubscriptionUsage(accountSets).pipe(
        Effect.map((usage) => ({
          ...usage,
          accountSets: usage.accountSets.filter((set) => set.members.length > 0)
        }))
      )
  });
  yield* addOwnedFinalizer(scope, platform, closeErrors, gateway.close);

  return {
    gateway,
    url: gateway.url(),
    providerStatuses: (signal) => backend.providerStatuses(signal),
    modelCatalog: () =>
      backend.listModelIds().flatMap((model) => {
        const info = backend.modelInfo(model);
        return info === undefined ? [] : [info];
      }),
    modelInfo: (model) => backend.modelInfo(model),
    accountSnapshots: () =>
      Object.values(accountSets).map((accountSet) => accountSet.statusSnapshot()),
    usage: (signal) =>
      collectSubscriptionUsage(accountSets, undefined, signal).pipe(
        Effect.map((usage) => ({
          ...usage,
          accountSets: usage.accountSets.filter((set) => set.members.length > 0)
        }))
      ),
    listResetCredits: (kind, label, signal) =>
      Effect.gen(function* () {
        const accountSet = accountSets[kind];
        if (accountSet === undefined || accountSet.size === 0) {
          return yield* new RouteKitFailure({
            message: `no ${kind} account pool is serving; enroll an account first`
          });
        }
        return yield* accountSet.listResetCredits(label, signal);
      }),
    redeemReset: (input, signal) =>
      Effect.gen(function* () {
        const accountSet = accountSets[input.kind];
        if (accountSet === undefined || accountSet.size === 0) {
          return yield* new RouteKitFailure({
            message: `no ${input.kind} account pool is serving; enroll an account first`
          });
        }
        const result = yield* accountSet.redeemResetCredit(
          {
            label: input.label,
            ...(input.creditId !== undefined ? { creditId: input.creditId } : {}),
            ...(input.redeemRequestId !== undefined
              ? { redeemRequestId: input.redeemRequestId }
              : {})
          },
          signal
        );
        const usage = snapshotsToUsage(
          (["claude-code", "codex"] as const).map((mode) => accountSets[mode]?.statusSnapshot())
        );
        return {
          ...result,
          usage: {
            ...usage,
            accountSets: usage.accountSets.filter((set) => set.members.length > 0)
          }
        };
      })
  } satisfies AcquiredGatewayGeneration;
});

export function startGatewayGenerationEffect(
  options: GatewayGenerationOptions
): Effect.Effect<RunningGatewayGeneration, Error, RouteKitPlatform> {
  return Effect.gen(function* () {
    const platform = yield* Effect.context<RouteKitPlatform>();
    const scope = yield* Scope.make("sequential");
    const closeErrors: unknown[] = [];
    const opened = yield* Effect.exit(
      acquireGatewayGeneration(options, scope, platform, closeErrors)
    );
    if (Exit.isFailure(opened)) {
      yield* Scope.close(scope, opened);
      const startupError = Cause.squash(opened.cause);
      const cleanupError = closeError(closeErrors, "gateway generation startup cleanup failed");
      return yield* Effect.fail(
        cleanupError === undefined
          ? toRouteKitFailure(startupError)
          : new AggregateError(
              [toRouteKitFailure(startupError), ...closeErrors],
              "gateway generation startup failed and cleanup was incomplete"
            )
      );
    }
    const close = Scope.close(scope, Exit.void).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const error = closeError(closeErrors, "gateway generation cleanup failed");
          return error === undefined ? Effect.void : Effect.fail(error);
        })
      )
    );
    return { ...opened.value, close };
  });
}
