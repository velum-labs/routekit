/**
 * Shared human vocabulary for live account activity and readiness.
 * JSON surfaces emit daemon fields as-is; these helpers are display-only.
 */

export type AccountActivityFields = {
  serving?: boolean;
  inFlight?: number;
  lastSelected?: boolean;
  lastSelectedAt?: number;
};

export type AccountReadinessFields = {
  credentialValid?: boolean;
  configured?: boolean;
  relayOpen?: boolean;
  relayReady?: boolean;
  poolEligible?: boolean;
  coolingUntil?: number;
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

/**
 * Short readiness tags for usage-style lines (fields may be absent on older
 * snapshots). Prefer explicit false/cooling over "ready".
 */
export function formatUsageReadinessSuffix(
  account: AccountReadinessFields,
  now = Date.now()
): string {
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
  account: AccountReadinessFields & { localOnly?: boolean }
): string {
  const base =
    account.credentialValid === false
      ? "stored; credential invalid"
      : account.configured === false
        ? "stored; routing disabled"
        : account.relayOpen === false
          ? "stored; configured; relay unavailable or cooling"
          : "stored; configured; relay ready";
  return account.localOnly === true ? `${base} · local-only` : base;
}

/** Compact readiness suffix used by top-level `status`. */
export function formatOverviewReadinessSuffix(
  account: AccountReadinessFields
): string {
  if (account.configured === false) return " · routing disabled";
  if (account.relayOpen === false) return " · relay unavailable or cooling";
  return "";
}

export function accountReadyForOverview(
  account: AccountReadinessFields
): boolean {
  return (
    account.credentialValid !== false &&
    account.configured !== false &&
    account.relayOpen !== false
  );
}
