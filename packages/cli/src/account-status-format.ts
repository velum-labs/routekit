/**
 * Shared human vocabulary for live account activity and readiness.
 * JSON surfaces emit daemon fields as-is; these helpers are display-only.
 */

import type { AccountReadinessReason, UpstreamAuthState } from "@velum-labs/routekit-contracts";

export type AccountActivityFields = {
  serving?: boolean;
  inFlight?: number;
  lastSelected?: boolean;
  lastSelectedAt?: number;
};

export type AccountReadinessFields = {
  credentialValid?: boolean;
  upstreamAuthState?: UpstreamAuthState;
  configured?: boolean;
  relayOpen?: boolean;
  relayReady?: boolean;
  poolEligible?: boolean;
  coolingUntil?: number;
  readinessReasons?: AccountReadinessReason[];
};

function selectionAge(lastSelectedAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - lastSelectedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Compact activity markers appended after an account label:
 * `(serving N)` and/or `(last selected … ago)`.
 */
export function formatAccountActivityMarkers(
  account: AccountActivityFields,
  now = Date.now()
): string {
  const markers: string[] = [];
  const inFlight = account.inFlight ?? 0;
  if (account.serving === true || inFlight > 0) {
    markers.push(`(serving ${inFlight})`);
  }
  if (account.lastSelected === true) {
    markers.push(
      account.lastSelectedAt !== undefined
        ? `(last selected ${selectionAge(account.lastSelectedAt, now)})`
        : "(last selected)"
    );
  }
  return markers.length === 0 ? "" : ` ${markers.join(" ")}`;
}

function readinessReasonLabel(reason: AccountReadinessReason, now: number): string {
  switch (reason.code) {
    case "credential_invalid":
      return "credential invalid";
    case "credential_expired":
      return "credential expired";
    case "provider_auth_rejected":
      return `upstream auth rejected (${reason.status}); re-login required`;
    case "provider_auth_refreshing":
      return "upstream auth refreshing";
    case "provider_auth_backoff":
      return `auth refresh retrying in ${Math.max(0, Math.ceil(reason.until - now / 1000))}s`;
    case "catalog_empty":
      return "catalog empty";
    case "model_unavailable":
      return `model unavailable (${reason.model})`;
    case "cooldown_active":
      return "cooling";
    case "provider_quota_rejected":
      return `provider rejected (${reason.window})`;
    case "provider_quota_exceeded":
      return `provider quota exceeded (${reason.window})`;
    case "quota_switch_threshold":
      return `quota threshold (${reason.window} ${Math.round(reason.utilization * 100)}%)`;
    default: {
      const unreachable: never = reason;
      return String(unreachable);
    }
  }
}

function readinessReasonsLabel(
  account: AccountReadinessFields,
  now = Date.now()
): string | undefined {
  if (account.readinessReasons === undefined || account.readinessReasons.length === 0) {
    return undefined;
  }
  return account.readinessReasons.map((reason) => readinessReasonLabel(reason, now)).join(", ");
}

/**
 * Short readiness tags for usage-style lines (fields may be absent on older
 * snapshots). Prefer explicit false/cooling over "ready".
 */
export function formatUsageReadinessSuffix(
  account: AccountReadinessFields,
  now = Date.now()
): string {
  const reason = readinessReasonsLabel(account, now);
  if (reason !== undefined) return ` · ${reason}`;
  if (account.credentialValid === false) return " · credential invalid";
  if (account.configured === false) return " · routing disabled";
  if (account.coolingUntil !== undefined && account.coolingUntil * 1000 > now) {
    return " · cooling";
  }
  if (account.poolEligible === false) return " · ineligible";
  if (account.relayOpen === false || account.relayReady === false) {
    return " · relay unavailable or cooling";
  }
  return "";
}

/** Enrollment/status detail used by `accounts status`. */
export function formatAccountsStatusDetail(
  account: AccountReadinessFields & { localOnly?: boolean },
  now = Date.now()
): string {
  const reason = readinessReasonsLabel(account, now);
  const base =
    account.configured === false
      ? "stored; routing disabled"
      : reason !== undefined
        ? `stored; configured; ${reason}`
        : account.credentialValid === false
          ? "stored; credential invalid"
          : account.relayOpen === false
            ? "stored; configured; relay unavailable or cooling"
            : "stored; configured; relay ready";
  return account.localOnly === true ? `${base} · local-only` : base;
}

/** Compact readiness suffix used by top-level `status`. */
export function formatOverviewReadinessSuffix(
  account: AccountReadinessFields,
  now = Date.now()
): string {
  if (account.configured === false) return " · routing disabled";
  const reason = readinessReasonsLabel(account, now);
  if (reason !== undefined) return ` · ${reason}`;
  if (account.relayOpen === false) return " · relay unavailable or cooling";
  return "";
}

export function accountReadyForOverview(account: AccountReadinessFields): boolean {
  return (
    account.credentialValid !== false &&
    account.configured !== false &&
    account.relayOpen !== false &&
    account.poolEligible !== false &&
    account.relayReady !== false &&
    (account.readinessReasons?.length ?? 0) === 0
  );
}
