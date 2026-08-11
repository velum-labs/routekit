import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { z } from "zod";

import { canonicalRateLimitWindowKey } from "./provider.js";
import type {
  AccountLimits,
  RateLimitDiagnostic,
  ResetCredit,
  ResetCreditSnapshot
} from "./types.js";

export type CooldownContext = {
  model?: string;
  windows?: string[];
};

export type PersistedMemberState = {
  limits?: AccountLimits;
  coolingUntil?: number;
  cooldownRevision?: number;
  cooldownContext?: CooldownContext;
};

export type PersistedTrackerFile = {
  rateLimitNormalizationVersion: 1;
  usageRefreshRequired?: true;
  members: Array<{ id: string } & PersistedMemberState>;
};

export type TrackerStateRead = {
  state: Map<string, PersistedMemberState>;
  migrated: boolean;
  requiresRefresh: boolean;
};

type Migration = { required: boolean };

const observationSourceSchema = z.enum(["headers", "response", "usage", "stream"]);
const completenessSchema = z.enum(["snapshot", "partial"]);
const rateLimitWindowInputSchema = z.looseObject({
  utilization: z.number(),
  status: z.string().optional(),
  resetsAt: z.number().finite().optional(),
  windowSeconds: z.number().finite().optional(),
  limitName: z.string().optional(),
  observedAt: z.number().finite().optional(),
  source: observationSourceSchema.optional()
});
const resetCreditSchema = z.looseObject({
  id: z.string().min(1),
  resetType: z.string().optional(),
  status: z.string().optional(),
  grantedAt: z.number().finite().optional(),
  expiresAt: z.number().finite().optional(),
  title: z.string().optional(),
  description: z.string().optional()
});
const resetCreditSnapshotInputSchema = z.looseObject({
  observedAt: z.number().finite().optional(),
  availableCount: z.number().finite().nonnegative(),
  credits: z.array(z.unknown()).optional()
});
const rateLimitDiagnosticSchema = z.looseObject({
  code: z.literal("invalid_utilization"),
  window: z.string(),
  field: z.enum(["utilization", "used_percent"])
});
const accountLimitsInputSchema = z.looseObject({
  windows: z.record(z.string(), z.unknown()),
  diagnostics: z.array(z.unknown()).optional(),
  planType: z.string().optional(),
  credits: z.record(z.string(), z.unknown()).optional(),
  resetCredits: z.unknown().optional(),
  observedAt: z.number().finite(),
  source: observationSourceSchema,
  completeness: completenessSchema.optional()
});
const cooldownContextInputSchema = z.looseObject({
  model: z.string().optional(),
  windows: z.array(z.unknown()).optional()
});
const memberStateInputSchema = z.looseObject({
  limits: z.unknown().optional(),
  coolingUntil: z.number().finite().optional(),
  cooldownRevision: z.number().int().nonnegative().optional(),
  cooldownContext: z.unknown().optional()
});
const memberEntrySchema = memberStateInputSchema.extend({ id: z.string() });
const currentTrackerFileSchema = z.looseObject({
  rateLimitNormalizationVersion: z.literal(1),
  usageRefreshRequired: z.literal(true).optional(),
  members: z.array(z.unknown())
});
const legacyArrayTrackerFileSchema = z.looseObject({
  rateLimitNormalizationVersion: z.unknown().optional(),
  usageRefreshRequired: z.unknown().optional(),
  members: z.array(z.unknown())
});
const legacyObjectTrackerFileSchema = z.looseObject({
  members: z.unknown()
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeRateLimitWindow(
  value: unknown,
  observedAt: number,
  source: AccountLimits["source"],
  migration: Migration
): AccountLimits["windows"][string] | undefined {
  const parsed = rateLimitWindowInputSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const windowObservedAt = parsed.data.observedAt ?? observedAt;
  const windowSource = parsed.data.source ?? source;
  if (parsed.data.observedAt === undefined || parsed.data.source === undefined) {
    migration.required = true;
  }
  return {
    utilization: parsed.data.utilization,
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.resetsAt !== undefined ? { resetsAt: parsed.data.resetsAt } : {}),
    ...(parsed.data.windowSeconds !== undefined
      ? { windowSeconds: parsed.data.windowSeconds }
      : {}),
    ...(parsed.data.limitName !== undefined ? { limitName: parsed.data.limitName } : {}),
    observedAt: windowObservedAt,
    source: windowSource
  };
}

function decodeResetCredit(value: unknown): ResetCredit | undefined {
  const parsed = resetCreditSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data;
}

function decodeResetCreditSnapshot(
  value: unknown,
  fallbackObservedAt: number,
  migration: Migration
): ResetCreditSnapshot | undefined {
  const parsed = resetCreditSnapshotInputSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const observedAt = parsed.data.observedAt ?? fallbackObservedAt;
  if (parsed.data.observedAt === undefined) migration.required = true;
  const credits = parsed.data.credits?.flatMap((entry) => {
    const credit = decodeResetCredit(entry);
    if (credit === undefined) {
      migration.required = true;
      return [];
    }
    return [credit];
  });
  return {
    observedAt,
    availableCount: Math.floor(parsed.data.availableCount),
    ...(credits !== undefined ? { credits } : {})
  };
}

function decodeAccountLimits(
  value: unknown,
  mode: SubscriptionMode | undefined,
  migration: Migration,
  discardWindows: boolean
): AccountLimits | undefined {
  const parsed = accountLimitsInputSchema.safeParse(value);
  if (!parsed.success) return undefined;
  let completeness = parsed.data.completeness;
  if (completeness === undefined) {
    migration.required = true;
    if (parsed.data.source === "usage") return undefined;
    completeness = "partial";
  }
  const windows = Object.create(null) as AccountLimits["windows"];
  if (!discardWindows) {
    for (const [key, raw] of Object.entries(parsed.data.windows)) {
      const window = decodeRateLimitWindow(
        raw,
        parsed.data.observedAt,
        parsed.data.source,
        migration
      );
      if (window === undefined) {
        migration.required = true;
        continue;
      }
      const canonicalKey = mode === undefined ? key : canonicalRateLimitWindowKey(mode, key);
      if (canonicalKey !== key) migration.required = true;
      Object.defineProperty(windows, canonicalKey, {
        value: window,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  }
  const diagnostics = parsed.data.diagnostics?.flatMap((entry): RateLimitDiagnostic[] => {
    const diagnostic = rateLimitDiagnosticSchema.safeParse(entry);
    if (!diagnostic.success) {
      migration.required = true;
      return [];
    }
    return [diagnostic.data];
  });
  const resetCredits = decodeResetCreditSnapshot(
    parsed.data.resetCredits,
    parsed.data.observedAt,
    migration
  );
  return {
    windows,
    ...(diagnostics !== undefined && diagnostics.length > 0 ? { diagnostics } : {}),
    observedAt: parsed.data.observedAt,
    source: parsed.data.source,
    completeness,
    ...(parsed.data.planType !== undefined ? { planType: parsed.data.planType } : {}),
    ...(parsed.data.credits !== undefined ? { credits: parsed.data.credits } : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {})
  };
}

function decodeMemberState(
  value: unknown,
  mode: SubscriptionMode | undefined,
  migration: Migration,
  discardWindows: boolean
): PersistedMemberState | undefined {
  const parsed = memberStateInputSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const limits = decodeAccountLimits(parsed.data.limits, mode, migration, discardWindows);
  let cooldownRevision = parsed.data.cooldownRevision ?? 0;
  if (parsed.data.coolingUntil !== undefined && cooldownRevision === 0) {
    cooldownRevision = 1;
    migration.required = true;
  }
  let cooldownContext: CooldownContext | undefined;
  const parsedContext = cooldownContextInputSchema.safeParse(parsed.data.cooldownContext);
  if (parsedContext.success) {
    const windows = parsedContext.data.windows?.filter(
      (item): item is string => typeof item === "string"
    );
    if (windows?.length !== parsedContext.data.windows?.length) migration.required = true;
    cooldownContext = {
      ...(parsedContext.data.model !== undefined ? { model: parsedContext.data.model } : {}),
      ...(windows !== undefined ? { windows } : {})
    };
  } else if (parsed.data.cooldownContext !== undefined) {
    migration.required = true;
  }
  return {
    ...(limits !== undefined ? { limits } : {}),
    ...(parsed.data.coolingUntil !== undefined ? { coolingUntil: parsed.data.coolingUntil } : {}),
    ...(cooldownRevision > 0 ? { cooldownRevision } : {}),
    ...(cooldownContext !== undefined ? { cooldownContext } : {})
  };
}

function decodeArrayMembers(
  entries: readonly unknown[],
  mode: SubscriptionMode | undefined,
  migration: Migration,
  discardWindows: boolean
): Map<string, PersistedMemberState> {
  const state = new Map<string, PersistedMemberState>();
  for (const entry of entries) {
    const parsed = memberEntrySchema.safeParse(entry);
    if (!parsed.success) {
      migration.required = true;
      continue;
    }
    const member = decodeMemberState(parsed.data, mode, migration, discardWindows);
    if (member !== undefined) state.set(parsed.data.id, member);
  }
  return state;
}

export function decodeRateLimitTrackerState(
  value: unknown,
  mode?: SubscriptionMode
): TrackerStateRead {
  const current = currentTrackerFileSchema.safeParse(value);
  if (current.success) {
    const migration = { required: current.data.usageRefreshRequired === true };
    return {
      state: decodeArrayMembers(
        current.data.members,
        mode,
        migration,
        mode === "codex" && current.data.usageRefreshRequired === true
      ),
      migrated: migration.required,
      requiresRefresh: mode === "codex" && current.data.usageRefreshRequired === true
    };
  }

  const legacyArray = legacyArrayTrackerFileSchema.safeParse(value);
  if (legacyArray.success) {
    const requiresRefresh =
      mode === "codex" &&
      (legacyArray.data.usageRefreshRequired === true ||
        legacyArray.data.members.some((entry) => {
          const parsed = memberStateInputSchema.safeParse(entry);
          return parsed.success && parsed.data.limits !== undefined;
        }));
    const migration = { required: true };
    return {
      state: decodeArrayMembers(legacyArray.data.members, mode, migration, requiresRefresh),
      migrated: true,
      requiresRefresh
    };
  }

  const legacyObject = legacyObjectTrackerFileSchema.safeParse(value);
  if (legacyObject.success && isRecord(legacyObject.data.members)) {
    const migration = { required: true };
    const state = new Map<string, PersistedMemberState>();
    for (const [id, raw] of Object.entries(legacyObject.data.members)) {
      const member = decodeMemberState(raw, mode, migration, mode === "codex");
      if (member !== undefined) state.set(id, member);
    }
    return { state, migrated: true, requiresRefresh: mode === "codex" };
  }

  return { state: new Map(), migrated: false, requiresRefresh: false };
}
