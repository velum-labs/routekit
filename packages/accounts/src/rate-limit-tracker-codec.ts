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
  version: 1;
  members: Array<{ id: string } & PersistedMemberState>;
};

export type TrackerStateRead = {
  state: Map<string, PersistedMemberState>;
};

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
  version: z.literal(1),
  members: z.array(z.unknown())
});
function decodeRateLimitWindow(
  value: unknown,
  observedAt: number,
  source: AccountLimits["source"]
): AccountLimits["windows"][string] | undefined {
  const parsed = rateLimitWindowInputSchema.safeParse(value);
  if (!parsed.success) return undefined;
  if (parsed.data.observedAt === undefined || parsed.data.source === undefined) return undefined;
  return {
    utilization: parsed.data.utilization,
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.resetsAt !== undefined ? { resetsAt: parsed.data.resetsAt } : {}),
    ...(parsed.data.windowSeconds !== undefined
      ? { windowSeconds: parsed.data.windowSeconds }
      : {}),
    ...(parsed.data.limitName !== undefined ? { limitName: parsed.data.limitName } : {}),
    observedAt: parsed.data.observedAt,
    source: parsed.data.source
  };
}

function decodeResetCredit(value: unknown): ResetCredit | undefined {
  const parsed = resetCreditSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data;
}

function decodeResetCreditSnapshot(
  value: unknown,
  _fallbackObservedAt: number
): ResetCreditSnapshot | undefined {
  const parsed = resetCreditSnapshotInputSchema.safeParse(value);
  if (!parsed.success || parsed.data.observedAt === undefined) return undefined;
  const credits = parsed.data.credits?.flatMap((entry) => {
    const credit = decodeResetCredit(entry);
    if (credit === undefined) return [];
    return [credit];
  });
  return {
    observedAt: parsed.data.observedAt,
    availableCount: Math.floor(parsed.data.availableCount),
    ...(credits !== undefined ? { credits } : {})
  };
}

function decodeAccountLimits(
  value: unknown,
  mode: SubscriptionMode | undefined
): AccountLimits | undefined {
  const parsed = accountLimitsInputSchema.safeParse(value);
  if (!parsed.success || parsed.data.completeness === undefined) return undefined;
  const windows = Object.create(null) as AccountLimits["windows"];
  for (const [key, raw] of Object.entries(parsed.data.windows)) {
    const window = decodeRateLimitWindow(raw, parsed.data.observedAt, parsed.data.source);
    if (window === undefined) return undefined;
    const canonicalKey = mode === undefined ? key : canonicalRateLimitWindowKey(mode, key);
    if (canonicalKey !== key) return undefined;
    Object.defineProperty(windows, canonicalKey, {
      value: window,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  const diagnostics = parsed.data.diagnostics?.flatMap((entry): RateLimitDiagnostic[] => {
    const diagnostic = rateLimitDiagnosticSchema.safeParse(entry);
    if (!diagnostic.success) return [];
    return [diagnostic.data];
  });
  const resetCredits = decodeResetCreditSnapshot(
    parsed.data.resetCredits,
    parsed.data.observedAt
  );
  return {
    windows,
    ...(diagnostics !== undefined && diagnostics.length > 0 ? { diagnostics } : {}),
    observedAt: parsed.data.observedAt,
    source: parsed.data.source,
    completeness: parsed.data.completeness,
    ...(parsed.data.planType !== undefined ? { planType: parsed.data.planType } : {}),
    ...(parsed.data.credits !== undefined ? { credits: parsed.data.credits } : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {})
  };
}

function decodeMemberState(
  value: unknown,
  mode: SubscriptionMode | undefined
): PersistedMemberState | undefined {
  const parsed = memberStateInputSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const limits = decodeAccountLimits(parsed.data.limits, mode);
  if (parsed.data.limits !== undefined && limits === undefined) return undefined;
  const cooldownRevision = parsed.data.cooldownRevision ?? 0;
  if (parsed.data.coolingUntil !== undefined && cooldownRevision === 0) return undefined;
  let cooldownContext: CooldownContext | undefined;
  const parsedContext = cooldownContextInputSchema.safeParse(parsed.data.cooldownContext);
  if (parsedContext.success) {
    const windows = parsedContext.data.windows?.filter(
      (item): item is string => typeof item === "string"
    );
    if (windows?.length !== parsedContext.data.windows?.length) return undefined;
    cooldownContext = {
      ...(parsedContext.data.model !== undefined ? { model: parsedContext.data.model } : {}),
      ...(windows !== undefined ? { windows } : {})
    };
  } else if (parsed.data.cooldownContext !== undefined) return undefined;
  return {
    ...(limits !== undefined ? { limits } : {}),
    ...(parsed.data.coolingUntil !== undefined ? { coolingUntil: parsed.data.coolingUntil } : {}),
    ...(cooldownRevision > 0 ? { cooldownRevision } : {}),
    ...(cooldownContext !== undefined ? { cooldownContext } : {})
  };
}

function decodeArrayMembers(
  entries: readonly unknown[],
  mode: SubscriptionMode | undefined
): Map<string, PersistedMemberState> {
  const state = new Map<string, PersistedMemberState>();
  for (const entry of entries) {
    const parsed = memberEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error("invalid rate-limit member entry");
    }
    const member = decodeMemberState(parsed.data, mode);
    if (member === undefined) throw new Error(`invalid rate-limit state for ${parsed.data.id}`);
    state.set(parsed.data.id, member);
  }
  return state;
}

export function decodeRateLimitTrackerState(
  value: unknown,
  mode?: SubscriptionMode
): TrackerStateRead {
  const current = currentTrackerFileSchema.safeParse(value);
  if (current.success) {
    return {
      state: decodeArrayMembers(current.data.members, mode)
    };
  }
  throw new Error("unsupported rate-limit tracker state");
}
