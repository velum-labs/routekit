import type { Option } from "effect";

import { Context } from "effect";

// Kept in their own module so the runner (schedule-runner.ts) and the catch-up
// pass (schedule/catch-up.ts) depend on a common type surface rather than on each
// other — avoiding an import cycle (RFC 0002 schedule.md).
import type { AgentRuntimeEvent } from "../../../../contracts/author/src/agent-event.ts";
import type { ApiFeatureContext } from "../../../../contracts/author/src/api.ts";
import type { FeatureLogger } from "../../../../contracts/author/src/feature-logger.ts";
import type { McpResolver } from "../../../../contracts/author/src/mcp.ts";
import type {
  ScheduleDefinition,
  ScheduleInvokeInput,
} from "../../../../contracts/author/src/schedule.ts";
import type { StateStore } from "../../../../contracts/author/src/stores.ts";
import type { TelemetryObserverShape } from "../../../../contracts/internal/src/runtime/telemetry-observer.ts";

/**
 * The host side of a schedule fire: a raw `invoke` that starts an agent run and
 * returns its event stream, plus the project state store. The runner wraps
 * `invoke` per fire into the author-facing handler args, so this internal shape
 * stays a plain stream factory (RFC 0002 schedule.md).
 */
export interface ScheduleRuntimeShape {
  readonly invoke: (
    input: ScheduleInvokeInput
  ) => AsyncIterable<AgentRuntimeEvent>;
  /** Per-fire diagnostic logger handed to the schedule's `run` handler (RFC 0011). */
  readonly logger: Option.Option<FeatureLogger>;
  /**
   * Resolve the MCP handle for one feature's fire. Each feature reads its OWN
   * colocated `features/<featureId>/mcp.json`, so `mcpFor(featureId)` returns a
   * resolver scoped to that feature's declared servers. Handed to the `run`
   * handler as `mcp`.
   */
  readonly mcpFor: (featureId: string) => McpResolver;
  /**
   * Tear down every MCP connection opened across all features' fires over the
   * runtime's life. Called once when the schedule scope releases; a no-op when
   * MCP was never used.
   */
  readonly closeMcp: () => Promise<void>;
  readonly useFor: (featureId: string) => ApiFeatureContext["use"];
  readonly store: StateStore;
  readonly telemetryObserver?: TelemetryObserverShape | undefined;
}

/**
 * A schedule paired with its registry name: the owning feature id for the
 * feature-named schedule, or the nested folder name for a
 * `schedules/<name>/schedule.{ts,md}` entry (RFC 0002 schedule.md).
 */
export interface NamedSchedule {
  readonly definition: ScheduleDefinition;
  readonly featureId: string;
  readonly name: string;
}

/**
 * The `ScheduleRuntime` service key. Yield it inside any `Effect.gen` to obtain
 * the host handles a fire needs; the requirement shows up in the Effect's `R`
 * channel until a Layer or `Effect.provideService` supplies it at the
 * composition root.
 *
 * Only the cron ARMING path reads the runtime from context. The fire path
 * itself (`fireScheduleOnce`, `fireAndRecord`, `fireScheduleDetached`,
 * `streamScheduleFire`) is Promise-based — an `async function` cannot carry a
 * Context requirement, and `fireAndRecord` runs its body through
 * `Effect.runPromise`, which requires an empty `R`. Those take a
 * {@link ScheduleRuntimeShape} value, handed down by whichever armed Effect
 * yielded the service.
 *
 * The live runtime is acquired as a scoped resource by `acquireScheduleRuntime`
 * (schedule-runner.ts), not built by a Layer: its MCP teardown must run when the
 * SESSION scope releases, and a scoped Layer's own scope closes as soon as
 * `runSchedules` returns — while the forked fire fibers are still live.
 */
export class ScheduleRuntime extends Context.Service<
  ScheduleRuntime,
  ScheduleRuntimeShape
>()("ScheduleRuntime") {}
