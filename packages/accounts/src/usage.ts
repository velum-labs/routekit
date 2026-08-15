import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import type { SubscriptionAccountConfigs, SubscriptionAccountSets } from "./gateway.js";
import { closeSubscriptionAccountSets, openSubscriptionAccountSets } from "./gateway.js";
import type { SubscriptionUsageResponse } from "./wire.js";
import { snapshotsToUsage } from "./wire.js";

export const DEFAULT_SUBSCRIPTION_USAGE_REFRESH_MS = 60_000;

export type SubscriptionUsageSource = {
  usage(): Effect.Effect<SubscriptionUsageResponse, Error, RouteKitPlatform>;
  close(): Effect.Effect<void, Error, RouteKitPlatform>;
};

export function collectSubscriptionUsage(
  accountSets: SubscriptionAccountSets,
  refreshAfterMs = DEFAULT_SUBSCRIPTION_USAGE_REFRESH_MS,
  signal?: AbortSignal
) {
  return Effect.gen(function* () {
    yield* Effect.all(
      Object.values(accountSets).map((accountSet) =>
        accountSet.refreshUsage(refreshAfterMs, signal)
      ),
      { concurrency: "unbounded" }
    );
    return snapshotsToUsage(
      (["claude-code", "codex"] as const).map((mode) => accountSets[mode]?.statusSnapshot())
    );
  });
}

export function openLocalSubscriptionUsage(
  input: { accounts?: SubscriptionAccountConfigs; refreshAfterMs?: number } = {}
) {
  return Effect.gen(function* () {
    const policy = { source: { kind: "auto" as const } };
    const accountSets = yield* openSubscriptionAccountSets(
      input.accounts ?? { "claude-code": policy, codex: policy }
    );
    let closed = false;
    return {
      usage: () =>
        collectSubscriptionUsage(
          accountSets,
          input.refreshAfterMs ?? DEFAULT_SUBSCRIPTION_USAGE_REFRESH_MS
        ),
      close: () => {
        if (closed) return Effect.void;
        closed = true;
        return closeSubscriptionAccountSets(accountSets);
      }
    } satisfies SubscriptionUsageSource;
  });
}
