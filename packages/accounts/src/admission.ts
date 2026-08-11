import type { AccountReadinessReason } from "@velum-labs/routekit-contracts";

import type { AccountLimits, CreditSnapshot } from "./types.js";

export type PoolReadiness = {
  eligible: boolean;
  reasons: AccountReadinessReason[];
};

export function hasUsableCredits(credits: CreditSnapshot | undefined): boolean {
  if (credits === undefined) return false;
  if (credits.unlimited === true) return true;
  return credits.hasCredits === true;
}

export function windowHeadroom(utilization: number): number {
  if (!Number.isFinite(utilization)) return 1;
  return Math.max(0, 1 - utilization);
}

export function memberHeadroom(
  limits: AccountLimits | undefined,
  isWindowRelevant: (key: string, limitName?: string) => boolean = () => true
): number {
  if (limits === undefined) return 1;
  const relevant = Object.entries(limits.windows).filter(([key, window]) =>
    isWindowRelevant(key, window.limitName)
  );
  if (relevant.length === 0) return 1;
  return Math.min(...relevant.map(([, window]) => windowHeadroom(window.utilization)));
}

export function isOverSwitchThreshold(headroom: number, switchThreshold: number): boolean {
  return headroom <= 1 - switchThreshold;
}

function blockingProviderReason(
  window: string,
  status: string | undefined
): AccountReadinessReason | undefined {
  const normalized = status?.trim().toLowerCase();
  if (normalized === "rejected") {
    return { code: "provider_quota_rejected", window, status: status! };
  }
  if (normalized === "exceeded") {
    return { code: "provider_quota_exceeded", window, status: status! };
  }
  return undefined;
}

export function quotaAdmissionReasons(input: {
  limits?: AccountLimits;
  switchThreshold: number;
  isWindowRelevant?: (key: string, limitName?: string) => boolean;
}): AccountReadinessReason[] {
  if (input.limits === undefined) return [];
  const relevant = input.isWindowRelevant ?? (() => true);
  const creditsUsable = hasUsableCredits(input.limits.credits);
  const reasons: AccountReadinessReason[] = [];
  for (const [key, window] of Object.entries(input.limits.windows)) {
    if (!relevant(key, window.limitName)) continue;
    const providerReason = blockingProviderReason(key, window.status);
    if (providerReason !== undefined) {
      reasons.push(providerReason);
      continue;
    }
    if (
      !creditsUsable &&
      isOverSwitchThreshold(windowHeadroom(window.utilization), input.switchThreshold)
    ) {
      reasons.push({
        code: "quota_switch_threshold",
        window: key,
        utilization: window.utilization,
        switchThreshold: input.switchThreshold
      });
    }
  }
  return reasons;
}

export function poolReadiness(input: {
  limits?: AccountLimits;
  switchThreshold: number;
  coolingUntil?: number;
  credentialExpiresAt?: number;
  hasRefreshToken?: boolean;
  catalogReady?: boolean;
  models?: readonly string[];
  model?: string;
  now?: number;
  isWindowRelevant?: (key: string, limitName?: string) => boolean;
}): PoolReadiness {
  const now = input.now ?? Date.now() / 1000;
  const reasons: AccountReadinessReason[] = [];
  if (input.catalogReady === true && (input.models?.length ?? 0) === 0) {
    reasons.push({ code: "catalog_empty" });
  }
  if (
    input.catalogReady === true &&
    input.model !== undefined &&
    input.models !== undefined &&
    !input.models.includes(input.model)
  ) {
    reasons.push({ code: "model_unavailable", model: input.model });
  }
  if (input.coolingUntil !== undefined && input.coolingUntil > now) {
    reasons.push({ code: "cooldown_active", until: input.coolingUntil });
  }
  if (
    input.credentialExpiresAt !== undefined &&
    input.credentialExpiresAt <= now &&
    input.hasRefreshToken !== true
  ) {
    reasons.push({ code: "credential_expired", expiresAt: input.credentialExpiresAt });
  }
  reasons.push(
    ...quotaAdmissionReasons({
      ...(input.limits !== undefined ? { limits: input.limits } : {}),
      switchThreshold: input.switchThreshold,
      ...(input.isWindowRelevant !== undefined ? { isWindowRelevant: input.isWindowRelevant } : {})
    })
  );
  return { eligible: reasons.length === 0, reasons };
}

export function isPoolEligible(input: Parameters<typeof poolReadiness>[0]): boolean {
  return poolReadiness(input).eligible;
}

export function windowAdmissionStatus(
  utilization: number,
  switchThreshold: number,
  credits: CreditSnapshot | undefined,
  providerStatus?: string
): string {
  const providerReason = blockingProviderReason("window", providerStatus);
  if (providerReason?.code === "provider_quota_rejected") return "rejected";
  if (providerReason?.code === "provider_quota_exceeded") return "exceeded";
  if (!isOverSwitchThreshold(windowHeadroom(utilization), switchThreshold)) {
    return providerStatus ?? "ok";
  }
  if (hasUsableCredits(credits)) return "credits-only";
  return "exhausted";
}
