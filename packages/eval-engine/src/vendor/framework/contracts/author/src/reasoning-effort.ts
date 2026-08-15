/**
 * The vocabulary of reasoning effort, ordered from most to least. Every schema
 * and guard in the framework derives from this list, so a new level cannot be
 * added here and silently rejected at a decode boundary.
 */
export const REASONING_EFFORTS = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  REASONING_EFFORTS.some((effort) => effort === value);

/** What a catalog entry says about reasoning, narrowed to the shared vocabulary. */
export interface ReasoningCapability {
  readonly defaultEffort?: string | undefined;
  readonly mandatory?: boolean | undefined;
  readonly supportedEfforts?: readonly string[] | undefined;
}

/**
 * The levels a model will actually accept.
 *
 * `undefined` (no entry) stays permissive -- a `~latest` alias or an unloaded
 * catalog is not evidence. An entry with no `reasoning` states the model does
 * not reason; the live catalog omits the key rather than sending null, so both
 * spellings mean the same thing. A published list is authoritative even when
 * every value in it decoded to nothing, and `mandatory` rules out `none`.
 */
export const supportedEffortsFor = (
  reasoning: ReasoningCapability | null | undefined,
  present: boolean
): readonly ReasoningEffort[] => {
  if (!present) {
    return REASONING_EFFORTS;
  }
  if (reasoning === null || reasoning === undefined) {
    return [];
  }
  const supported = reasoning.supportedEfforts;
  const offered =
    supported === undefined
      ? REASONING_EFFORTS
      : supported.filter(isReasoningEffort);
  return reasoning.mandatory === true
    ? offered.filter((effort) => effort !== "none")
    : offered;
};

/**
 * What each harness binary actually accepts, keyed by the level this framework
 * speaks. A level absent from a harness's map is dropped rather than sent: the
 * binary would reject the flag and fail the turn.
 *
 * Two levels mapping to the same value is not a mistake -- pi has no `max`, so
 * `max` and `xhigh` are one notch there. The picker reads that to say so rather
 * than offering two rows that do the same thing.
 *
 * Verified against the pinned pi 0.80.2 (`off|minimal|low|medium|high|xhigh`)
 * and Claude Code's own `--effort` allowlist.
 */
const HARNESS_EFFORT_FLAGS: Readonly<
  Record<string, Partial<Record<ReasoningEffort, string>>>
> = {
  claude: {
    low: "low",
    max: "max",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  },
  pi: {
    low: "low",
    max: "xhigh",
    medium: "medium",
    high: "high",
    minimal: "minimal",
    none: "off",
    xhigh: "xhigh",
  },
};

/**
 * The flag value `harness` sends for `effort`, or `undefined` when the harness
 * has no such level. An unrecognized harness returns the level unchanged: not
 * knowing its vocabulary is not evidence that it lacks one.
 */
export const harnessEffortFlag = (
  harness: string | undefined,
  effort: ReasoningEffort
): string | undefined => {
  const flags =
    harness === undefined ? undefined : HARNESS_EFFORT_FLAGS[harness];
  return flags === undefined ? effort : flags[effort];
};

/**
 * The levels worth offering for this model on this harness: the model's own
 * list, minus anything the harness has no flag for, minus any level that is
 * only an alias of one already in the list.
 *
 * Nothing that would not take effect is shown. A level the harness drops would
 * leave the footer claiming a setting that reached nothing, and an alias
 * (`max` on pi, which has only `xhigh`) would be a second row doing the first
 * row's job. Where a level and its alias both survive, the one the harness
 * itself names wins, so the list reads in the harness's own vocabulary.
 */
export const selectableEffortsFor = (
  supported: readonly ReasoningEffort[],
  harness: string | undefined
): readonly ReasoningEffort[] => {
  const byFlag = new Map<string, ReasoningEffort>();
  for (const effort of supported) {
    const flag = harnessEffortFlag(harness, effort);
    if (flag === undefined) {
      continue;
    }
    const held = byFlag.get(flag);
    if (held === undefined || effort === flag) {
      byFlag.set(flag, effort);
    }
  }
  const kept = new Set(byFlag.values());
  return supported.filter((effort) => kept.has(effort));
};

/**
 * The level to send when nobody picked one: the model's published default when
 * it is usable, else the bundled fallback, else whatever it does offer.
 * `undefined` means send none at all.
 */
export const effectiveEffortFor = (
  reasoning: ReasoningCapability | null | undefined,
  present: boolean,
  fallback: ReasoningEffort = DEFAULT_REASONING_EFFORT
): ReasoningEffort | undefined => {
  const efforts = supportedEffortsFor(reasoning, present);
  if (efforts.length === 0) {
    return undefined;
  }
  const published = reasoning?.defaultEffort;
  if (isReasoningEffort(published) && efforts.includes(published)) {
    return published;
  }
  return efforts.includes(fallback) ? fallback : efforts[0];
};
