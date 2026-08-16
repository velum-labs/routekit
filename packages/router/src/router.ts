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
  type RouterConfig
} from "@velum-labs/routekit-config";
import type {
  CatalogModelInfo,
  Gateway,
  ProvenanceSink,
  ProviderSource,
  RequestClassifierService,
  RoutingPolicyReader
} from "@velum-labs/routekit-gateway";
import {
  AnthropicBackend,
  ClassificationError,
  CodexResponsesBackend,
  invokeObservedModelCall,
  makeLanguageModelClassifier,
  RoutingBackend
} from "@velum-labs/routekit-gateway";
import { startGatewayEffect } from "@velum-labs/routekit-gateway/effect";
import {
  assertAuthenticatedBind,
  extendCleanupGrace,
  registerCleanup
} from "@velum-labs/routekit-runtime";
import {
  EffectResourceScope,
  RouteKitFailure,
  type RouteKitPlatform,
  runRouteKitEffect,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

export type StartRouterOptions = {
  config: RouterConfig;
  host?: string;
  port?: number;
  authToken?: string;
  env?: NodeJS.ProcessEnv;
  sources?: Partial<Record<ProviderId, ProviderSource>>;
  provenance?: ProvenanceSink;
  /** Published eval-routing profiles used when a request specifies `model: "auto"`. */
  policyReader?: RoutingPolicyReader;
  /** Override the default small-LM classifier used by `model: "auto"`. */
  classifier?: RequestClassifierService;
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

export type RedeemResetOptions = {
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

export type RedeemResetResponse = RedeemResetCreditResult & {
  usage: SubscriptionUsageResponse;
};

export type RunningRouter = {
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
    input: RedeemResetOptions,
    signal?: AbortSignal
  ): Effect.Effect<RedeemResetResponse, Error, RouteKitPlatform>;
};

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

export function startRouterEffect(
  options: StartRouterOptions
): Effect.Effect<RunningRouter, Error, RouteKitPlatform> {
  return Effect.gen(function* () {
    const platform = yield* Effect.context<RouteKitPlatform>();
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
    const startup = new EffectResourceScope();
    yield* startup.deferEffect(closeSubscriptionAccountSets(accountSets));
    const failedStartup = (error: Error) =>
      startup.dispose().pipe(
        Effect.matchEffect({
          onFailure: (cleanupError) =>
            Effect.fail(new AggregateError([error, cleanupError], "router startup failed")),
          onSuccess: () => Effect.fail(error)
        })
      );
    const requiredKinds = new Set(
      (["claude-code", "codex"] as const).filter(
        (provider) =>
          options.config.providers[provider] !== undefined &&
          options.sources?.[provider] === undefined
      )
    );
    for (const kind of requiredKinds) {
      if ((accountSets[kind]?.size ?? 0) === 0) {
        return yield* failedStartup(
          new RouteKitFailure({
            message:
              `provider "${kind}" requires an enrolled account; ` +
              `run \`routekit accounts login ${kind} --name <label>\``
          })
        );
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
    }).pipe(Effect.catch(failedStartup));
    const configuredClassifierModel = options.config.classifierModel;
    const classifierModel = configuredClassifierModel ?? DEFAULT_CLASSIFIER_MODEL;
    const classifier =
      options.classifier ??
      (backend.ports.models.serves(classifierModel)
        ? makeLanguageModelClassifier({
            model: classifierModel,
            complete: (body) =>
              invokeObservedModelCall(options.provenance, {
                dialect: "openai-chat",
                body,
                defaultModel: backend.defaultModel,
                requestedModel: classifierModel,
                endpointId: "request-classifier",
                invoke: (callId, signal, onAttribution) =>
                  backend.chat(body, signal, {
                    modelCallId: callId,
                    responseMode: "buffered",
                    onAttribution
                  })
              }).pipe(Effect.provide(platform))
          })
        : {
            classify: () =>
              Effect.fail(
                new ClassificationError({
                  message: `classifier model ${JSON.stringify(
                    configuredClassifierModel ?? DEFAULT_CLASSIFIER_MODEL
                  )} is unavailable; configure classifierModel to a served model`
                })
              )
          });
    const gateway = yield* startGatewayEffect({
      backend,
      host,
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
      ...(options.policyReader !== undefined ? { policyReader: options.policyReader } : {}),
      classifier,
      ...(Object.keys(relays).length > 0 ? { providerRelays: relays } : {}),
      usage: () =>
        collectSubscriptionUsage(accountSets).pipe(
          Effect.map((usage) => ({
            ...usage,
            accountSets: usage.accountSets.filter((set) => set.members.length > 0)
          }))
        )
    }).pipe(
      Effect.catch((error) =>
        startup.deferEffect(backend.close()).pipe(Effect.andThen(failedStartup(error)))
      )
    );
    yield* startup.deferEffect(gateway.close);
    const liveResources = new EffectResourceScope();
    yield* startup.transferTo(liveResources);
    let unregisterCleanup = (): void => {};
    const close = Effect.sync(() => unregisterCleanup()).pipe(
      Effect.andThen(liveResources.dispose())
    );
    const drainGraceMs = options.drainGraceMs ?? 0;
    if (drainGraceMs > 0) {
      // The cleanup registry's default bound would SIGKILL-equivalent the drain
      // after 5s; a service granted a drain window needs the bound to cover it.
      extendCleanupGrace(drainGraceMs + 5_000);
    }
    unregisterCleanup = registerCleanup(async () => {
      await runRouteKitEffect(
        (drainGraceMs > 0 ? gateway.drain(drainGraceMs) : Effect.void).pipe(Effect.andThen(close))
      );
    });
    return {
      gateway,
      url: gateway.url(),
      close,
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
    } satisfies RunningRouter;
  });
}

/** Process-boundary wrapper over the Effect router constructor. */
export async function startRouter(options: StartRouterOptions): Promise<RunningRouter> {
  return runRouteKitEffect(startRouterEffect(options));
}
