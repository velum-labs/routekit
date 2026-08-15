// Type-only import (erased at runtime): `effect` is a devDependency here, never a
// runtime dependency, so the effect-free author surface is preserved. Authors get
// the value-level `Schema` (e.g. `import { Schema } from "routekit-eval"`) from the SDK
// preamble the contract-generation pipeline emits, not from this package (RFC 0002 schedule.md).
import type { Schema } from "effect";

import type { AgentRuntimeEvent } from "./agent-event.ts";
import type { ApiFeatureContext } from "./api.ts";
import type { FeatureLogger } from "./feature-logger.ts";
import type { McpResolver } from "./mcp.ts";
import type { StateStore } from "./stores.ts";
import type { ValueOf } from "../../../utils/core/src/types.ts";

/** A single fire's request for a local agent run (RFC 0002 schedule.md). */
interface ScheduleInvokeInput<A = unknown> {
  /**
   * Optional structured-output contract. When set, the run is asked to return a
   * JSON object matching this schema and {@link AgentRun.output} resolves to the
   * decoded, validated value instead of the caller hand-parsing assistant text.
   */
  readonly output?: Schema.ConstraintDecoder<A> | undefined;
  readonly prompt: string;
  readonly sessionId?: string | undefined;
}

/**
 * A started agent run (RFC 0002 schedule.md). It is the run's live event stream — drain it
 * with `for await` — and also exposes the run's final assistant text and, when an
 * `output` schema was supplied to {@link ScheduleInvokeInput}, its decoded
 * structured result. Awaiting `text`/`output` runs the stream to completion.
 */
interface AgentRun<A = unknown> extends AsyncIterable<AgentRuntimeEvent> {
  /**
   * Resolve the run's structured result, validated against the `output` schema.
   * Rejects when no `output` schema was supplied, or when the run's response
   * cannot be parsed/validated against it.
   */
  readonly output: () => Promise<A>;
  /** Resolve the run's concatenated assistant text. */
  readonly text: () => Promise<string>;
}

/**
 * Host-provided handle passed to a schedule's `run` handler. `invoke` starts a
 * local agent run through the daemon; `store` is the one framework resource a
 * standalone schedule file cannot otherwise reach, e.g. burn-alert dedupe (RFC
 * 0002 schedule.md).
 */
interface ScheduleHandlerArgs {
  readonly invoke: <A = unknown>(input: ScheduleInvokeInput<A>) => AgentRun<A>;
  /** Diagnostic logger for this fire, pre-scoped to the owning feature (RFC 0011). */
  readonly logger: FeatureLogger;
  /**
   * Reach an MCP server declared in the workspace `mcp.json`. Optional: present
   * only when the host wired MCP for this fire, so a handler guards before use.
   */
  readonly mcp?: McpResolver | undefined;
  /** Call another feature's `api.exports`; dependency edges are enforced. */
  readonly use: ApiFeatureContext["use"];
  readonly store: StateStore;
}

/**
 * How a fire that is still running when the next cron tick arrives is handled
 * (opt-in resilience; the default preserves the historical behavior):
 *
 * - `skip` (default): drop the overlapping tick and stay on the cron cadence —
 *   never more than one fire of a schedule in flight at a time.
 * - `queue`: serialize fires so an overlapping tick runs after the in-flight one
 *   finishes instead of being dropped. Useful when every tick must run, but the
 *   queue can grow if fires routinely outlast their interval.
 */
export const ScheduleOverlapPolicy = {
  Queue: "queue",
  Skip: "skip",
} as const;
export type ScheduleOverlapPolicy = ValueOf<typeof ScheduleOverlapPolicy>;

/**
 * A feature's schedule: a cron job that fires a headless agent run. A feature
 * owns at most one, authored as the `feature.ts` `schedule` export or a
 * standalone `features/<id>/schedule.{ts,md}` file (named for the feature). The
 * runtime owns cron evaluation and firing; a definition supplies exactly one of
 * `markdown` (fire-and-forget prompt) or `run` (custom handler) (RFC 0002 schedule.md).
 *
 * Set `disabled: true` to keep the schedule loaded — still listed by
 * `routekit-eval schedules` and still manually dispatchable in dev — but never armed on the
 * cron, so it stops firing on its own. Omitting `disabled` (or setting `false`)
 * arms it as usual. This is the kill switch for a noisy schedule that should not
 * be deleted outright.
 *
 * `catchUp` (default `false`) opts the schedule into missed-fire recovery: when
 * the runtime restarts after being down across one or more scheduled instants,
 * a single catch-up fire runs at boot. Missed fires are coalesced — a gap of N
 * instants triggers one fire, not N — and the next fire stays on the normal cron
 * cadence. Off by default so a restart never produces a surprise fire (RFC 0006
 * cron evaluator, catch-up).
 */
interface ScheduleDefinition {
  readonly cron: string;
  readonly timezone?: string | undefined;
  /** When `true`, the schedule is loaded but never armed on the cron. Defaults to `false`. */
  readonly disabled?: boolean | undefined;
  readonly markdown?: string | undefined;
  readonly run?:
    | ((args: ScheduleHandlerArgs) => Promise<void> | void)
    | undefined;
  readonly catchUp?: boolean | undefined;
  /** Overlap handling when a fire is still running at the next tick. Defaults to `skip`. */
  readonly overlap?: ScheduleOverlapPolicy | undefined;
  /**
   * Upper bound (milliseconds) on a random delay applied before each fire to
   * splay schedules that share a tick (avoiding a thundering herd at, e.g., the
   * top of the hour). `0`/unset fires immediately on the tick.
   */
  readonly jitterMs?: number | undefined;
}

/** Fields common to every schedule definition, regardless of which form it fires. */
interface ScheduleDefinitionBase {
  readonly cron: string;
  readonly timezone?: string | undefined;
  /** When `true`, the schedule is loaded but never armed on the cron. Defaults to `false`. */
  readonly disabled?: boolean | undefined;
  readonly catchUp?: boolean | undefined;
  readonly overlap?: ScheduleOverlapPolicy | undefined;
  readonly jitterMs?: number | undefined;
}

/**
 * The author-facing input to {@link defineSchedule}: a definition supplies
 * **exactly one** of `markdown` or `run` (RFC 0002 schedule.md). Expressed as a union so
 * the compiler rejects both supplying neither and supplying both — the same
 * invariant `ScheduleDefinitionSchema` enforces at boot, now caught at authoring
 * time. The `?: never` arms make the two members mutually exclusive while still
 * allowing the omitted key to be absent.
 */
export type DefineScheduleInput =
  | (ScheduleDefinitionBase & {
      readonly markdown: string;
      readonly run?: never;
    })
  | (ScheduleDefinitionBase & {
      readonly run: (args: ScheduleHandlerArgs) => Promise<void> | void;
      readonly markdown?: never;
    });

/** Type pass-through that types the `schedule` named export (`feature.ts` or `schedule.ts`) (RFC 0002 schedule.md). */
export const defineSchedule = (
  definition: DefineScheduleInput
): ScheduleDefinition => definition;

export type {
  ScheduleInvokeInput,
  AgentRun,
  ScheduleHandlerArgs,
  ScheduleDefinition,
};
