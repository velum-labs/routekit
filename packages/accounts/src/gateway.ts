import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { ResourceScope } from "@velum-labs/routekit-runtime";

import type { CoordinatorResource, SubscriptionAccountSetOptions } from "./account-set.js";
import { SubscriptionAccountSet } from "./account-set.js";
import type { AccountActivityCoordinator } from "./activity.js";
import type { AccountAuthCoordinator } from "./auth-health.js";
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
  activity?: CoordinatorResource<AccountActivityCoordinator>;
  authHealth?: CoordinatorResource<AccountAuthCoordinator>;
  codex?: Omit<CodexRelayOptions, "auth">;
};

export type OpenSubscriptionRelaysResult = {
  relays: Partial<Record<SubscriptionRelayDialect, ReturnType<typeof relayPorts>>>;
  accountSets: SubscriptionAccountSets;
};

export type SubscriptionAccountSets = Partial<Record<SubscriptionMode, SubscriptionAccountSet>>;

const subscriptionAccountSetScopes = new WeakMap<SubscriptionAccountSets, ResourceScope>();

export function relayPorts(relay: SubscriptionRelay) {
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
    ...(relay.close !== undefined
      ? {
          lifecycle: {
            kind: "lifecycle" as const,
            close: relay.close.bind(relay)
          }
        }
      : {})
  };
}

export async function closeSubscriptionAccountSets(
  sets: SubscriptionAccountSets
): Promise<void> {
  const resources = subscriptionAccountSetScopes.get(sets);
  if (resources !== undefined) {
    await resources.dispose();
    return;
  }

  const errors: unknown[] = [];
  for (const mode of ["codex", "claude-code"] as const) {
    const accounts = sets[mode];
    if (accounts === undefined) continue;
    try {
      await accounts.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "one or more subscription account sets failed to close");
  }
}

function stockCatalog(
  _template: CodexCatalogEntry,
  stock: readonly CodexCatalogEntry[]
): CodexCatalogEntry[] {
  return [...stock];
}

export async function openSubscriptionAccountSets(
  configs: SubscriptionAccountConfigs,
  activity?: CoordinatorResource<AccountActivityCoordinator>,
  authHealth?: CoordinatorResource<AccountAuthCoordinator>
): Promise<SubscriptionAccountSets> {
  const sets: SubscriptionAccountSets = {};
  const startup = new ResourceScope();
  try {
    const sharedActivity =
      activity?.ownership === "owned"
        ? startup.own(activity.resource)
        : activity?.resource;
    const sharedAuthHealth =
      authHealth?.ownership === "owned"
        ? startup.own(authHealth.resource)
        : authHealth?.resource;
    for (const mode of ["claude-code", "codex"] as const) {
      const config = configs[mode];
      if (config === undefined) continue;
      sets[mode] = startup.own(
        await SubscriptionAccountSet.open(subscriptionProvider(mode), {
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
  } catch (error) {
    try {
      await startup.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "subscription account startup failed");
    }
    throw error;
  }
}

export function subscriptionRelaysFromAccountSets(
  sets: SubscriptionAccountSets,
  codex?: Omit<CodexRelayOptions, "auth">
): Partial<Record<SubscriptionRelayDialect, ReturnType<typeof relayPorts>>> {
  const relays: Partial<Record<SubscriptionRelayDialect, ReturnType<typeof relayPorts>>> = {};
  const claude = sets["claude-code"];
  if (claude !== undefined && claude.size > 0) {
    relays.anthropic = relayPorts(new AnthropicBackendRelay({ accounts: claude }));
  }
  const codexAccounts = sets.codex;
  if (codexAccounts !== undefined && codexAccounts.size > 0) {
    relays.codex = relayPorts(new CodexBackendRelay({
      catalog: stockCatalog,
      ...codex,
      auth: { kind: "accounts", accounts: codexAccounts }
    }));
  }
  return relays;
}

/** Open every configured server-owned subscription through one account-set path. */
export async function openSubscriptionRelays(
  options: OpenSubscriptionRelaysOptions
): Promise<OpenSubscriptionRelaysResult> {
  const sets = await openSubscriptionAccountSets(
    options.accounts,
    options.activity,
    options.authHealth
  );
  try {
    const relays = subscriptionRelaysFromAccountSets(sets, options.codex);
    for (const mode of ["claude-code", "codex"] as const) {
      const accounts = sets[mode];
      if (accounts === undefined) continue;
      const hasRelay =
        (mode === "claude-code" && relays.anthropic !== undefined) ||
        (mode === "codex" && relays.codex !== undefined);
      if (!hasRelay) {
        await accounts.close();
        delete sets[mode];
      }
    }
    return { relays, accountSets: sets };
  } catch (error) {
    try {
      await closeSubscriptionAccountSets(sets);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "subscription relay startup failed");
    }
    throw error;
  }
}
