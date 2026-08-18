import type { Cron, Scope } from "effect";

import { join } from "node:path";

import { Array as Arr, Clock, Data, Duration, Effect, Option } from "effect";

import type { ApiFeatureContext } from "../../../../contracts/author/src/api.ts";
import type { McpResolver } from "../../../../contracts/author/src/mcp.ts";
import type { ScheduleInvokeInput } from "../../../../contracts/author/src/schedule.ts";
import type { StateStore } from "../../../../contracts/author/src/stores.ts";
import type { TelemetryObserverShape } from "../../../../contracts/internal/src/runtime/telemetry-observer.ts";
import type { ChatOptions } from "../chat/index.ts";
import type { ParsedCron } from "./cron.ts";
import type {
  NamedSchedule,
  ScheduleRuntimeShape,
} from "./types.ts";

import { AgentInvokeCell } from "../agent/invoke-cell.ts";
import { makeAuthorMcpResolver } from "../author/mcp-resolver.ts";
import { makeChat } from "../chat/index.ts";
import { cronCadence } from "./cadence.ts";
import { catchUpMissedFires } from "./catch-up.ts";
import { parseCron } from "./cron.ts";
import { fireAndRecord } from "./fire.ts";
import { HOST_TIMEZONE } from "./host-timezone.ts";
import {
  classifyScheduleRunOutcome,
  isRecordedAgentFailure,
  ScheduleOutcomeError,
  updateScheduleRunFailure,
} from "./outcome.ts";
import { computeJitterDelayMs } from "./resilience.ts";
import { ScheduleRuntime } from "./types.ts";

interface ScheduleRuntimeConfig extends ChatOptions {
  readonly store: StateStore;
  readonly useFor: (featureId: string) => ApiFeatureContext["use"];
  readonly telemetryObserver?: TelemetryObserverShape | undefined;
}

/**
 * A schedule whose cron expression is malformed or whose timezone is unknown.
 * The schedule is skipped; the rest still arm.
 */
class ScheduleCronParseError extends Data.TaggedError(
  "ScheduleCronParseError"
)<{
  readonly cause: Cron.CronParseError;
  readonly message: string;
  readonly scheduleName: string;
}> {}

/**
 * A schedule whose cron parsed but has no upcoming fire (a calendar-impossible
 * expression such as `0 6 31 2 *`). Distinct from a parse failure: the
 * expression is well-formed, it just never comes round.
 */
class ScheduleNoUpcomingFireError extends Data.TaggedError(
  "ScheduleNoUpcomingFireError"
)<{
  readonly message: string;
  readonly scheduleName: string;
}> {}

/** Why one schedule could not be armed. */
type ScheduleArmError = ScheduleCronParseError | ScheduleNoUpcomingFireError;

/**
 * Build the host-provided handler args for schedule fires. `invoke` routes each
 * run through the daemon's `/api/invoke` path (the same path chat turns use);
 * `store` is the project state store (RFC 0002 schedule.md).
 *
 * Pure construction. Publishing `invoke` for hook handlers to reach is the
 * caller's decision, not a side effect of building a runtime — the dev
 * single-fire route builds a throwaway per-request runtime that must not
 * displace the daemon's.
 */
const makeScheduleRuntime = (
  config: ScheduleRuntimeConfig
): ScheduleRuntimeShape => {
  const chat = makeChat({
    ...config,
    telemetrySurface: "schedule",
  });
  // Each feature's `run` handler reads its OWN colocated MCP declaration at
  // `features/<featureId>/mcp.json`, so a resolver is built per feature (cached
  // for the runtime's life) rather than once against a shared workspace file.
  // Connections open lazily on first `mcp(name)` call; `closeMcp` tears down
  // every feature's connections when the schedule scope releases.
  const resolvers = new Map<string, ReturnType<typeof makeAuthorMcpResolver>>();
  const mcpFor = (featureId: string): McpResolver => {
    const existing = resolvers.get(featureId);
    if (existing !== undefined) {
      return existing.mcp;
    }
    const resolver = makeAuthorMcpResolver({
      configPath: join(
        config.featuresRoot ?? config.cwd,
        featureId,
        "mcp.json"
      ),
      env: globalThis.process.env,
    });
    resolvers.set(featureId, resolver);
    return resolver.mcp;
  };
  const closeMcp = async (): Promise<void> => {
    // allSettled, not all: one resolver's failed close must not abort the others.
    await Promise.allSettled([...resolvers.values()].map((r) => r.close()));
    resolvers.clear();
  };
  const runtime: ScheduleRuntimeShape = {
    invoke: (input: ScheduleInvokeInput) => chat.sendMessage(input),
    logger: Option.fromNullishOr(config.logger),
    mcpFor,
    closeMcp,
    useFor: config.useFor,
    store: config.store,
    telemetryObserver: config.telemetryObserver,
  };
  return runtime;
};

/**
 * Tear down every MCP connection the fires opened. Best-effort by contract: a
 * close that rejects is swallowed so it never turns an orderly shutdown into a
 * defect. `Effect.acquireRelease` types its release channel as `never`, and a
 * bare `Effect.promise` over a rejecting promise dies rather than fails, so the
 * `.catch` is what makes scope release total.
 */
const releaseScheduleRuntime = (
  runtime: ScheduleRuntimeShape
): Effect.Effect<void> =>
  Effect.promise(() =>
    runtime.closeMcp().catch(() => {
      // Ignore: a failed connection close must not fail scope release.
    })
  );

/**
 * Bind a schedule runtime's MCP lifetime to the CALLER's scope.
 *
 * Deliberately not a scoped `Layer` + `Effect.provide`: a layer's scope closes
 * as soon as the effect it provides returns, and `runSchedules` returns
 * immediately after forking its fire fibers — so the layer form tears MCP down
 * while every schedule is still firing. Acquiring against the ambient scope
 * instead registers the release before any fiber is forked, and scope
 * finalizers run LIFO, so the fibers are interrupted first and `closeMcp` runs
 * last. That is the same ordering the previous `Effect.addFinalizer` produced.
 */
const scopedScheduleRuntime = (
  acquire: Effect.Effect<ScheduleRuntimeShape>
): Effect.Effect<ScheduleRuntimeShape, never, Scope.Scope> =>
  Effect.acquireRelease(acquire, releaseScheduleRuntime);

/**
 * Build the long-lived schedule runtime, publish its `invoke` so hook handlers
 * booted earlier can finally reach one, and bind its MCP teardown to the
 * caller's scope. The composition root hands the result to `runSchedules` with
 * `Effect.provideService(ScheduleRuntime, runtime)`.
 */
const acquireScheduleRuntime = Effect.fn("acquireScheduleRuntime")(function* (
  config: ScheduleRuntimeConfig
) {
  const agentInvoke = yield* AgentInvokeCell;
  const runtime = yield* scopedScheduleRuntime(
    Effect.sync(() => makeScheduleRuntime(config))
  );
  yield* agentInvoke.publish(runtime.invoke);
  return runtime;
});

const NO_JITTER_MS = 0;

export const fireAndObserveSchedule = Effect.fn("fireAndObserveSchedule")(
  function* (target: {
    readonly definition: NamedSchedule["definition"];
    readonly featureId: string;
    readonly name: string;
    readonly runtime: ScheduleRuntimeShape;
  }) {
    const startedAt = yield* Clock.currentTimeMillis;
    let failed = false;
    yield* Effect.tryPromise(() =>
      fireAndRecord(
        {
          definition: target.definition,
          featureId: target.featureId,
          name: target.name,
          runtime: target.runtime,
        },
        {
          onEvent: (event) => {
            failed = updateScheduleRunFailure({
              customRun: target.definition.run !== undefined,
              event,
              failed,
            });
          },
        }
      )
    ).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          failed = true;
        })
      ),
      Effect.ignore
    );
    if (target.runtime.telemetryObserver !== undefined) {
      yield* target.runtime.telemetryObserver
        .observe("schedule_run", {
          duration_ms: (yield* Clock.currentTimeMillis) - startedAt,
          outcome: classifyScheduleRunOutcome(failed),
        })
        .pipe(Effect.ignore);
    }
  }
);

const fireAndObserveCatchUp = Effect.fn("fireAndObserveCatchUp")(
  (target: {
    readonly definition: NamedSchedule["definition"];
    readonly featureId: string;
    readonly name: string;
    readonly runtime: ScheduleRuntimeShape;
  }): Effect.Effect<readonly string[], ScheduleOutcomeError> =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      let failed = false;
      const result = yield* Effect.exit(
        Effect.tryPromise({
          catch: (cause) => new ScheduleOutcomeError({ cause }),
          try: () =>
            fireAndRecord(
              {
                definition: target.definition,
                featureId: target.featureId,
                name: target.name,
                runtime: target.runtime,
              },
              {
                onEvent: (event) => {
                  failed = updateScheduleRunFailure({
                    customRun: target.definition.run !== undefined,
                    event,
                    failed,
                  });
                },
              }
            ),
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              failed = true;
            })
          )
        )
      );
      if (target.runtime.telemetryObserver !== undefined) {
        yield* target.runtime.telemetryObserver
          .observe("schedule_run", {
            duration_ms: (yield* Clock.currentTimeMillis) - startedAt,
            outcome: classifyScheduleRunOutcome(failed),
          })
          .pipe(Effect.ignore);
      }
      if (result._tag === "Failure") {
        // A streamed terminal failure was already written to run history and
        // logged by fireAndRecord, so it is handled here and the catch-up
        // wrapper does not add a second, less useful breadcrumb. Discriminated
        // on the thrown cause rather than on having seen a failed turn: a run
        // that recovered from one and then died for an unrelated reason has
        // that second cause recorded nowhere, and swallowing it leaves the
        // operator with a catch-up that reports nothing at all.
        if (isRecordedAgentFailure(result.cause)) {
          return [];
        }
        return yield* Effect.failCause(result.cause);
      }
      return result.value;
    })
);

/**
 * The Clock-driven fire path for one schedule: an Effect `Schedule` supplies the
 * cadence and `Effect.schedule` sleeps to each tick before running the body.
 * `Effect.schedule` (not `Effect.repeat`) is deliberate — `repeat` runs its body
 * before the first schedule step, which would fire every schedule once at arm
 * time.
 *
 * `jitterMs` splays each fire by a random delay in `[0, jitterMs)` to avoid a
 * thundering herd when many schedules share a tick. It is an additive sleep at
 * the head of the body, so a jittered fire can only ever land at or after its
 * cron instant, never before it.
 */
const runScheduleLoop = Effect.fn("runScheduleLoop")(function* (
  schedule: NamedSchedule,
  parsed: ParsedCron
) {
  const runtime = yield* ScheduleRuntime;
  const fire = Effect.gen(function* fireOnTick() {
    const jitter = yield* computeJitterDelayMs(schedule.definition.jitterMs);
    if (jitter > NO_JITTER_MS) {
      yield* Effect.sleep(Duration.millis(jitter));
    }
    yield* fireAndObserveSchedule({
      definition: schedule.definition,
      featureId: schedule.featureId,
      name: schedule.name,
      runtime,
    }).pipe(Effect.ignore);
  });
  yield* Effect.schedule(
    fire,
    cronCadence(schedule.definition.overlap, parsed)
  );
});

/**
 * Arm one schedule. A `disabled` schedule is skipped without forking a fiber and
 * without failing; a malformed cron, an unknown timezone, and a
 * calendar-impossible cron each fail with a {@link ScheduleArmError}. A valid,
 * enabled schedule forks its fire loop.
 */
const armSchedule = Effect.fn("armSchedule")(function* (
  schedule: NamedSchedule
) {
  if (schedule.definition.disabled === true) {
    return;
  }
  const timezone = schedule.definition.timezone ?? HOST_TIMEZONE;
  const parsed = yield* parseCron(schedule.definition.cron, timezone).pipe(
    Effect.mapError(
      (cause) =>
        new ScheduleCronParseError({
          cause,
          message: `Could not parse cron for schedule "${schedule.name}".`,
          scheduleName: schedule.name,
        })
    )
  );
  // A calendar-impossible cron (e.g. Feb 31) parses fine but never fires — a
  // successful `null`, distinct from a CronParseError. Fail rather than fork a
  // fiber that sleeps forever.
  const now = yield* Clock.currentTimeMillis;
  if (parsed.nextFire(new Date(now)) === null) {
    return yield* new ScheduleNoUpcomingFireError({
      message: `No upcoming fire for schedule "${schedule.name}".`,
      scheduleName: schedule.name,
    });
  }
  yield* Effect.forkScoped(runScheduleLoop(schedule, parsed));
});

/**
 * Arm every schedule as a scoped fiber driven by the Effect `Clock` (RFC 0002 schedule.md):
 * each loop `Effect.sleep`s to its next fire, so production uses the live wall
 * clock while tests inject `TestClock`. Releasing the caller's scope interrupts
 * the fibers. One bad schedule is skipped and collected, never short-circuiting
 * the arm loop; the failures are returned for the caller to report.
 *
 * After arming, a best-effort catch-up pass fires any `catchUp` schedule that
 * missed a scheduled instant while the runtime was down (RFC 0006 cron evaluator,
 * catch-up). The pass reads "now" from the same Effect `Clock`, forks each
 * catch-up fire into this scope, and never blocks arming — schedules without
 * `catchUp` keep the plain Clock fire loop with no catch-up or jitter.
 */
export const runSchedules = Effect.fn("runSchedules")(function* (
  schedules: readonly NamedSchedule[]
) {
  // `Effect.result` per schedule, not a bare `Effect.forEach`: a bare forEach
  // short-circuits on the first failure, so one malformed cron would stop every
  // later schedule from arming. Reducing each arm to a Result keeps the loop
  // total and hands the failures back as values.
  const armed = yield* Effect.forEach(
    schedules,
    (schedule) => Effect.result(armSchedule(schedule)),
    // Sequential, matching the arm order the returned failures are reported in.
    { concurrency: 1 }
  );
  // Catch-up reads "now" from the same Clock the fire loop uses, so production
  // sees the live wall clock and tests stay deterministic under `TestClock`.
  const nowMillis = yield* Clock.currentTimeMillis;
  yield* catchUpMissedFires(schedules, {
    fire: fireAndObserveCatchUp,
    now: new Date(nowMillis),
  });
  return Arr.getFailures(armed);
});

export {
  acquireScheduleRuntime,
  makeScheduleRuntime,
  scopedScheduleRuntime,
  ScheduleCronParseError,
  ScheduleNoUpcomingFireError,
};
export type { ScheduleArmError, ScheduleRuntimeConfig };
