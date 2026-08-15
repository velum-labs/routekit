// Cron evaluation backed by Effect's `Cron` module. It owns next-fire
// computation only; the recurring timer loop is driven by an Effect
// `Clock` in schedule-runner.ts so the cadence is mockable under `TestClock`.
// This module is the single integration point for cron parsing (RFC 0006).
import { Cron, Effect } from "effect";

interface ParsedCron {
  /**
   * The parsed expression, bound to the timezone given at parse time. Exposed so
   * the runner can build an Effect `Schedule` from it without re-parsing the
   * expression string.
   */
  readonly cron: Cron.Cron;
  /**
   * The next instant strictly after `from` at which the schedule fires, or
   * `null` when the expression has no upcoming fire (e.g. a calendar-impossible
   * `0 6 31 2 *`). Evaluated in the timezone bound at parse time.
   */
  readonly nextFire: (from: Date) => Date | null;
}

/**
 * `Cron.next` throws once its candidate search is exhausted, which is how a
 * calendar-impossible expression (`0 6 31 2 *` — February never has 31 days)
 * surfaces. That is a successful parse with no upcoming fire, which
 * {@link ParsedCron} reports as `null`, so the throw is converted here rather
 * than escaping: callers branch on `null` to skip arming a schedule that would
 * otherwise sleep forever.
 */
const nextFireOrNull = (cron: Cron.Cron, from: Date): Date | null => {
  try {
    return Cron.next(cron, from);
  } catch {
    return null;
  }
};

/**
 * Parse and validate a cron expression bound to an IANA timezone, returning a
 * reusable next-fire evaluator. Fails with `Cron.CronParseError` for a malformed
 * expression (bad field count, out-of-range values) or an unknown timezone — a
 * calendar-impossible-but-valid cron is *not* an error; it succeeds and its
 * `nextFire` returns `null`.
 *
 * Day-of-month and day-of-week follow standard (Vixie) cron: when both are
 * restricted the schedule fires on days matching *either* field.
 */
export const parseCron = (
  expression: string,
  timezone?: string
): Effect.Effect<ParsedCron, Cron.CronParseError> =>
  Effect.fromResult(Cron.parse(expression, timezone)).pipe(
    Effect.map((cron) => ({
      cron,
      nextFire: (from: Date): Date | null => nextFireOrNull(cron, from),
    }))
  );

export type { ParsedCron };
