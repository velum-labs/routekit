import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ModelSelectionSignals
} from "@velum-labs/routekit-contracts";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import type { ResourceOwnership } from "@velum-labs/routekit-runtime";
import type { SubscriptionAccountSource } from "../account-source.js";
import type { AccountActivityService } from "../activity.js";
import type { AccountAuthService } from "../auth-health.js";
import type { ConsumeResetCreditResult, SubscriptionProvider } from "../provider.js";
import type { SubscriptionExecutionObserver } from "../subscription-request-executor.js";
import type {
  SubscriptionAccountSetSnapshot,
  SubscriptionCredential,
  SubscriptionSelectionStrategy
} from "../types.js";

export type CoordinatorResource<T> = { resource: T; ownership: ResourceOwnership };

export type SubscriptionAccountSetOptions = {
  activity?: CoordinatorResource<AccountActivityService>;
  authHealth?: CoordinatorResource<AccountAuthService>;
  source?: SubscriptionAccountSource;
  strategy?: SubscriptionSelectionStrategy;
  switchThreshold?: number;
  probeIntervalMs?: number;
  refreshSkewSeconds?: number;
  fallbackCooldownSeconds?: number;
  beforeAcquisitionRevalidation?: (member: { label: string }) => Promise<void>;
};

export type RedeemResetCreditInput = {
  label: string;
  creditId?: string;
  redeemRequestId?: string;
};

export type RedeemResetCreditResult = ConsumeResetCreditResult & {
  label: string;
  mode: SubscriptionMode;
};

export type AccountSetMember = import("../subscription-pool-selection.js").SubscriptionPoolMember;

export type AccountSetState<M extends SubscriptionMode = SubscriptionMode> = {
  provider: SubscriptionProvider<M>;
  members: AccountSetMember[];
  mode: M;
  tracker: import("../rate-limit-tracker.js").RateLimitTracker;
  activity: AccountActivityService;
  authHealth: AccountAuthService;
  selector: import("../subscription-pool-selection.js").SubscriptionPoolSelector;
  metadata: Map<string, ModelCapabilityMetadata>;
  selectionSignals: Map<string, ModelSelectionSignals>;
  reasoning: Map<string, ModelReasoningCapabilities>;
  catalogReady: boolean;
  switchThreshold: number;
  refreshSkewSeconds: number;
  fallbackCooldownSeconds: number;
  ensureFresh: (member: AccountSetMember, signal?: AbortSignal) => Promise<void>;
  fetchUsageWithAuthRecovery: (
    member: AccountSetMember,
    signal?: AbortSignal
  ) => Promise<import("../types.js").AccountLimits>;
  attachResetCredits: (
    member: AccountSetMember,
    limits: import("../types.js").AccountLimits,
    signal?: AbortSignal
  ) => Promise<import("../types.js").AccountLimits>;
  fetchResetCredits: (
    member: AccountSetMember,
    signal?: AbortSignal
  ) => Promise<import("../types.js").ResetCreditSnapshot>;
};

export type {
  SubscriptionAccountSetSnapshot,
  SubscriptionCredential,
  SubscriptionExecutionObserver
};
