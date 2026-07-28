import { z } from "zod";

import type { SubscriptionAccountSetSnapshot } from "./types.js";

/**
 * The typed wire contract for the proxy's native usage endpoint. The gateway
 * server serializes account-set snapshots through this schema and
 * `SubscriptionProxyClient` parses responses through it, so the producer and
 * consumer share one source of truth instead of casting an inline shape.
 */
export const SUBSCRIPTION_USAGE_PATH = "/usage";

const rateLimitWindowSchema = z.object({
  utilization: z.number(),
  status: z.string().optional(),
  resetsAt: z.number().optional(),
  windowSeconds: z.number().optional(),
  limitName: z.string().optional(),
  observedAt: z.number(),
  source: z.enum(["headers", "response", "usage", "stream"])
});

const creditSnapshotSchema = z.object({
  hasCredits: z.boolean().optional(),
  unlimited: z.boolean().optional(),
  balance: z.string().optional()
});

const resetCreditSchema = z.object({
  id: z.string(),
  resetType: z.string().optional(),
  status: z.string().optional(),
  grantedAt: z.number().optional(),
  expiresAt: z.number().optional(),
  title: z.string().optional(),
  description: z.string().optional()
});

const resetCreditSnapshotSchema = z.object({
  observedAt: z.number(),
  availableCount: z.number(),
  credits: z.array(resetCreditSchema).optional()
});

const accountLimitsSchema = z.object({
  windows: z.record(z.string(), rateLimitWindowSchema),
  planType: z.string().optional(),
  credits: creditSnapshotSchema.optional(),
  resetCredits: resetCreditSnapshotSchema.optional(),
  observedAt: z.number(),
  source: z.enum(["headers", "response", "usage", "stream"]),
  completeness: z.enum(["snapshot", "partial"])
});

const readinessReasonSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("catalog_empty") }),
  z.object({ code: z.literal("model_unavailable"), model: z.string() }),
  z.object({ code: z.literal("cooldown_active"), until: z.number() }),
  z.object({ code: z.literal("credential_invalid") }),
  z.object({ code: z.literal("credential_expired"), expiresAt: z.number() }),
  z.object({
    code: z.literal("provider_quota_rejected"),
    window: z.string(),
    status: z.string()
  }),
  z.object({
    code: z.literal("provider_quota_exceeded"),
    window: z.string(),
    status: z.string()
  }),
  z.object({
    code: z.literal("quota_switch_threshold"),
    window: z.string(),
    utilization: z.number(),
    switchThreshold: z.number()
  })
]);

const memberStatusSchema = z.object({
  id: z.string(),
  mode: z.enum(["claude-code", "codex"]),
  label: z.string(),
  sourcePath: z.string(),
  expiresAt: z.number().optional(),
  coolingUntil: z.number().optional(),
  active: z.boolean(),
  serving: z.boolean(),
  inFlight: z.number().int().nonnegative(),
  lastSelectedAt: z.number().optional(),
  lastSelected: z.boolean(),
  credentialValid: z.boolean().optional(),
  relayReady: z.boolean().optional(),
  poolEligible: z.boolean().optional(),
  readinessReasons: z.array(readinessReasonSchema).optional(),
  models: z.array(z.string()),
  limits: accountLimitsSchema.optional()
});

const accountSetSnapshotSchema = z.object({
  mode: z.enum(["claude-code", "codex"]),
  strategy: z.enum(["sticky", "round_robin", "capacity_weighted"]),
  switchThreshold: z.number(),
  members: z.array(memberStatusSchema)
});

/** `GET /usage` response: the live snapshot of every configured account set. */
export const subscriptionUsageResponseSchema = z.object({
  accountSets: z.array(accountSetSnapshotSchema)
});

export type SubscriptionUsageResponse = z.infer<typeof subscriptionUsageResponseSchema>;

/** Build the usage response from account-set snapshots (skips undefined sets). */
export function snapshotsToUsage(
  snapshots: readonly (SubscriptionAccountSetSnapshot | undefined)[]
): SubscriptionUsageResponse {
  return {
    accountSets: snapshots.filter(
      (snapshot): snapshot is SubscriptionAccountSetSnapshot => snapshot !== undefined
    )
  };
}

// Compile-time guarantee that the schema stays aligned with the domain type.
type _AccountSetParity =
  SubscriptionAccountSetSnapshot extends z.infer<typeof accountSetSnapshotSchema> ? true : never;
const _accountSetParity: _AccountSetParity = true;
void _accountSetParity;
