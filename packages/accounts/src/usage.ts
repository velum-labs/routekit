import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import type { SubscriptionAccountConfigs, SubscriptionAccountSets } from "./gateway.js";
import { closeSubscriptionAccountSets, openSubscriptionAccountSets } from "./gateway.js";
import type { SubscriptionUsageResponse } from "./wire.js";
import { snapshotsToUsage } from "./wire.js";

export const DEFAULT_SUBSCRIPTION_USAGE_REFRESH_MS = 60_000;

export type SubscriptionUsageSource = {
  usage(): Promise<SubscriptionUsageResponse>;
  close(): Promise<void>;
};

export async function collectSubscriptionUsage(
  accountSets: SubscriptionAccountSets,
  refreshAfterMs = DEFAULT_SUBSCRIPTION_USAGE_REFRESH_MS,
  signal?: AbortSignal
): Promise<SubscriptionUsageResponse> {
  await Promise.all(
    Object.values(accountSets).map(async (accountSet) => {
      await runRouteKitEffect(accountSet.refreshUsage(refreshAfterMs, signal));
    })
  );
  return snapshotsToUsage(
    (["claude-code", "codex"] as const).map((mode) => accountSets[mode]?.statusSnapshot())
  );
}

export async function openLocalSubscriptionUsage(
  input: { accounts?: SubscriptionAccountConfigs; refreshAfterMs?: number } = {}
): Promise<SubscriptionUsageSource> {
  const policy = { source: { kind: "auto" as const } };
  const accountSets = await runRouteKitEffect(
    openSubscriptionAccountSets(input.accounts ?? { "claude-code": policy, codex: policy })
  );
  let closed = false;
  return {
    usage: async () =>
      await collectSubscriptionUsage(
        accountSets,
        input.refreshAfterMs ?? DEFAULT_SUBSCRIPTION_USAGE_REFRESH_MS
      ),
    close: async () => {
      if (closed) return;
      closed = true;
      await runRouteKitEffect(closeSubscriptionAccountSets(accountSets));
    }
  };
}
