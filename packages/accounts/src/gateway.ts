import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { ResourceScope } from "@velum-labs/routekit-runtime/lifecycle";
import { toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import type { CoordinatorResource, SubscriptionAccountSetOptions } from "./account-set/types.js";
import { SubscriptionAccountSet } from "./account-set.js";
import type { AccountActivityCoordinator, AccountActivityService } from "./activity.js";
import type { AccountAuthCoordinator, AccountAuthService } from "./auth-health.js";
import type { CodexCatalogEntry, CodexRelayOptions } from "./codex-relay.js";
import { CodexBackendRelay } from "./codex-relay.js";
import { subscriptionProvider } from "./provider.js";
import type { SubscriptionRelay, SubscriptionRelayDialect } from "./relay.js";
import { AnthropicBackendRelay } from "./relay.js";

export type SubscriptionAccountConfigs = Partial<
  Record<SubscriptionMode, SubscriptionAccountSetOptions>
>;

export type OpenSubscriptionRelaysOptions = {
  accounts: SubscriptionAccountConfigs;
  activity?: CoordinatorResource<AccountActivityCoordinator | AccountActivityService>;
  authHealth?: CoordinatorResource<AccountAuthCoordinator | AccountAuthService>;
  codex?: Omit<CodexRelayOptions, "auth">;
};

export type OpenSubscriptionRelaysResult = {
  relays: Partial<Record<SubscriptionRelayDialect, ReturnType<typeof relayPorts>>>;
  accountSets: SubscriptionAccountSets;
};

export type SubscriptionAccountSets = Partial<Record<SubscriptionMode, SubscriptionAccountSet>>;

const subscriptionAccountSetScopes = new WeakMap<SubscriptionAccountSets, ResourceScope>();

export function relayPorts(relay: SubscriptionRelay) {
  const close = relay.close;
  return {
    request: relay,
    ...(relay.models !== undefined
      ? {
          catalog: {
            kind: "models" as const,
            dialect: "anthropic" as const,
            models: relay.models.bind(relay)
          }
        }
      : relay.mergedCatalog !== undefined && relay.mergeDataIds !== undefined
        ? {
            catalog: {
              kind: "merged-models" as const,
              dialect: "codex" as const,
              mergedCatalog: relay.mergedCatalog.bind(relay),
              mergeDataIds: relay.mergeDataIds.bind(relay)
            }
          }
        : {}),
    ...(relay.countTokens !== undefined
      ? {
          tokenCount: {
            kind: "token-count" as const,
            dialect: "anthropic" as const,
            countTokens: relay.countTokens.bind(relay)
          }
        }
      : {}),
    ...(close !== undefined
      ? {
          lifecycle: {
            kind: "lifecycle" as const,
            close: Effect.suspend(() => close.call(relay))
          }
        }
      : {})
  };
}

export function closeSubscriptionAccountSets(sets: SubscriptionAccountSets) {
  return Effect.gen(function* () {
    const resources = subscriptionAccountSetScopes.get(sets);
    if (resources !== undefined) {
      yield* Effect.tryPromise({
        try: () => resources.dispose(),
        catch: toRouteKitFailure
      });
      return;
    }

    const errors: unknown[] = [];
    for (const mode of ["codex", "claude-code"] as const) {
      const accounts = sets[mode];
      if (accounts === undefined) continue;
      yield* accounts.close().pipe(
        Effect.catch((error) => {
          errors.push(error);
          return Effect.void;
        })
      );
    }
    if (errors.length > 0) {
      return yield* Effect.fail(
        new AggregateError(errors, "one or more subscription account sets failed to close")
      );
    }
  });
}

function stockCatalog(
  _template: CodexCatalogEntry,
  stock: readonly CodexCatalogEntry[]
): CodexCatalogEntry[] {
  return [...stock];
}

export function openSubscriptionAccountSets(
  configs: SubscriptionAccountConfigs,
  activity?: CoordinatorResource<AccountActivityCoordinator | AccountActivityService>,
  authHealth?: CoordinatorResource<AccountAuthCoordinator | AccountAuthService>
) {
  return Effect.suspend(() => {
    const sets: SubscriptionAccountSets = {};
    const startup = new ResourceScope();
    return Effect.gen(function* () {
      const sharedActivity =
        activity?.ownership === "owned" ? startup.own(activity.resource) : activity?.resource;
      const sharedAuthHealth =
        authHealth?.ownership === "owned" ? startup.own(authHealth.resource) : authHealth?.resource;
      for (const mode of ["claude-code", "codex"] as const) {
        const config = configs[mode];
        if (config === undefined) continue;
        sets[mode] = startup.own(
          yield* SubscriptionAccountSet.open(subscriptionProvider(mode), {
            ...config,
            ...(sharedActivity !== undefined
              ? { activity: { resource: sharedActivity, ownership: "borrowed" } }
              : {}),
            ...(sharedAuthHealth !== undefined
              ? { authHealth: { resource: sharedAuthHealth, ownership: "borrowed" } }
              : {})
          })
        );
      }
      const liveResources = new ResourceScope();
      startup.transferTo(liveResources);
      subscriptionAccountSetScopes.set(sets, liveResources);
      return sets;
    }).pipe(
      Effect.catch((error) =>
        Effect.tryPromise({
          try: () => startup.dispose(),
          catch: (cleanupError) =>
            new AggregateError([error, cleanupError], "subscription account startup failed")
        }).pipe(Effect.andThen(Effect.fail(error)))
      )
    );
  });
}

export function subscriptionRelaysFromAccountSets(
  sets: SubscriptionAccountSets,
  codex?: Omit<CodexRelayOptions, "auth">
): Partial<Record<SubscriptionRelayDialect, ReturnType<typeof relayPorts>>> {
  const relays: Partial<Record<SubscriptionRelayDialect, ReturnType<typeof relayPorts>>> = {};
  const claude = sets["claude-code"];
  if (claude !== undefined && claude.size > 0) {
    relays.anthropic = relayPorts(
      new AnthropicBackendRelay({
        accounts: claude
      })
    );
  }
  const codexAccounts = sets.codex;
  if (codexAccounts !== undefined && codexAccounts.size > 0) {
    relays.codex = relayPorts(
      new CodexBackendRelay({
        catalog: stockCatalog,
        ...codex,
        auth: { kind: "accounts", accounts: codexAccounts }
      })
    );
  }
  return relays;
}

/** Open every configured server-owned subscription through one account-set path. */
export function openSubscriptionRelays(options: OpenSubscriptionRelaysOptions) {
  return Effect.gen(function* () {
    const sets = yield* openSubscriptionAccountSets(
      options.accounts,
      options.activity,
      options.authHealth
    );
    return yield* Effect.gen(function* () {
      const relays = subscriptionRelaysFromAccountSets(sets, options.codex);
      for (const mode of ["claude-code", "codex"] as const) {
        const accounts = sets[mode];
        if (accounts === undefined) continue;
        const hasRelay =
          (mode === "claude-code" && relays.anthropic !== undefined) ||
          (mode === "codex" && relays.codex !== undefined);
        if (!hasRelay) {
          yield* accounts.close();
          delete sets[mode];
        }
      }
      return { relays, accountSets: sets };
    }).pipe(
      Effect.catch((error) =>
        closeSubscriptionAccountSets(sets).pipe(
          Effect.matchEffect({
            onFailure: (cleanupError) =>
              Effect.fail(
                new AggregateError([error, cleanupError], "subscription relay startup failed")
              ),
            onSuccess: () => Effect.fail(error)
          })
        )
      )
    );
  });
}
