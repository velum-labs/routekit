import type {
  AccountActivityState,
  AccountReadinessState,
  ProviderFailure
} from "@velum-labs/routekit-contracts";
import type { CapacityPoolStrategy } from "@velum-labs/routekit-gateway";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";

export type SubscriptionSelectionStrategy = CapacityPoolStrategy;
export type RateLimitObservationSource = "headers" | "response" | "usage" | "stream";

export type SubscriptionCredential = {
  mode: SubscriptionMode;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  sourcePath: string;
};

export type RateLimitWindow = {
  utilization: number;
  status?: string;
  resetsAt?: number;
  windowSeconds?: number;
  limitName?: string;
  observedAt: number;
  source: RateLimitObservationSource;
};

export type CreditSnapshot = {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string;
};

/**
 * A banked Codex rate-limit reset coupon. Orthogonal to {@link CreditSnapshot}
 * (ongoing team/extra-usage billing credits).
 */
export type ResetCredit = {
  id: string;
  resetType?: string;
  status?: string;
  grantedAt?: number;
  expiresAt?: number;
  title?: string;
  description?: string;
};

export type ResetCreditSnapshot = {
  observedAt: number;
  availableCount: number;
  credits?: ResetCredit[];
};

export type AccountLimits = {
  windows: Record<string, RateLimitWindow>;
  planType?: string;
  credits?: CreditSnapshot;
  /** Banked redeemable rate-limit resets (Codex); not team billing credits. */
  resetCredits?: ResetCreditSnapshot;
  observedAt: number;
  source: RateLimitObservationSource;
  /** Whether this observation replaces all windows or updates only those present. */
  completeness: "snapshot" | "partial";
};

export type SubscriptionFailure = Pick<
  ProviderFailure,
  "category" | "message" | "retryAfter" | "resetsAt"
> & {
  /** Provider-native structured error identity, safe to preserve downstream. */
  type?: string;
  code?: string;
};

export type SubscriptionMemberStatus = AccountActivityState &
  AccountReadinessState & {
    id: string;
    mode: SubscriptionMode;
    label: string;
    sourcePath: string;
    expiresAt?: number;
    coolingUntil?: number;
    models: string[];
    limits?: AccountLimits;
  };

export type SubscriptionAccountSetSnapshot = {
  mode: SubscriptionMode;
  strategy: SubscriptionSelectionStrategy;
  switchThreshold: number;
  members: SubscriptionMemberStatus[];
};
