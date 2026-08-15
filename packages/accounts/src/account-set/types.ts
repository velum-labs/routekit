import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import type { ResourceOwnership } from "@velum-labs/routekit-runtime";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import type { Effect } from "effect";
import type { SubscriptionAccountSource } from "../account-source.js";
import type { AccountActivityCoordinator, AccountActivityService } from "../activity.js";
import type { AccountAuthCoordinator, AccountAuthService } from "../auth-health.js";
import type { ConsumeResetCreditResult } from "../provider.js";
import type { SubscriptionExecutionObserver } from "../subscription-request-executor.js";
import type {
  SubscriptionAccountSetSnapshot,
  SubscriptionCredential,
  SubscriptionSelectionStrategy
} from "../types.js";

export type CoordinatorResource<T> = { resource: T; ownership: ResourceOwnership };

export type SubscriptionAccountSetOptions = {
  activity?: CoordinatorResource<AccountActivityCoordinator | AccountActivityService>;
  authHealth?: CoordinatorResource<AccountAuthCoordinator | AccountAuthService>;
  source?: SubscriptionAccountSource;
  strategy?: SubscriptionSelectionStrategy;
  switchThreshold?: number;
  probeIntervalMs?: number;
  refreshSkewSeconds?: number;
  fallbackCooldownSeconds?: number;
  beforeAcquisitionRevalidation?: (member: {
    label: string;
  }) => Effect.Effect<void, Error, RouteKitPlatform>;
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

export type {
  SubscriptionAccountSetSnapshot,
  SubscriptionCredential,
  SubscriptionExecutionObserver
};
