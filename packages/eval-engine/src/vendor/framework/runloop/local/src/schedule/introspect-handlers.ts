import { Clock, Effect } from "effect";

import type { ScheduleDefinition } from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import type { ScheduleRunRecord } from "../../../../contracts/internal/src/runtime/schedule-introspection.ts";
import type { FeatureBootResult } from "../feature-boot/types.ts";
import type {
  ScheduleUnavailableErrorBody,
  UnknownScheduleErrorBody,
} from "./schedule-http-api.ts";

import { FeatureRuntime } from "../feature-runtime/service.ts";
import { featureLoggerOptionFromContext } from "../logging/support.ts";
import {
  buildScheduleSummaries,
  buildScheduleSummary,
} from "./introspect.ts";
import {
  latestRunsByScheduleId,
  listScheduleRuns,
} from "./run-store.ts";

const DEFAULT_RUN_LIMIT = 20;
const MIN_RUN_LIMIT = 1;
const MAX_RUN_LIMIT = 200;
const DECIMAL_RADIX = 10;

const EMPTY_RUNS: ReadonlyMap<string, ScheduleRunRecord> = new Map();
const EMPTY_RUN_LIST: readonly ScheduleRunRecord[] = [];

const UNAVAILABLE_ERROR =
  "Schedule introspection is unavailable for this runtime.";

/** Clamp a `?limit=` query value into `[MIN_RUN_LIMIT, MAX_RUN_LIMIT]`, defaulting when absent or invalid. */
const parseRunLimit = (raw: string | null): number => {
  if (raw === null) {
    return DEFAULT_RUN_LIMIT;
  }
  const parsed = Number.parseInt(raw, DECIMAL_RADIX);
  if (Number.isNaN(parsed)) {
    return DEFAULT_RUN_LIMIT;
  }
  return Math.min(MAX_RUN_LIMIT, Math.max(MIN_RUN_LIMIT, parsed));
};

const inspectFeatureBoot = Effect.fn("RuntimeHttp.inspectFeatureBoot")(
  function* (featuresRoot: string | undefined) {
    if (featuresRoot === undefined) {
      return yield* Effect.succeedNone;
    }
    const featureRuntime = yield* FeatureRuntime;
    return yield* featureRuntime.inspect(featuresRoot).pipe(Effect.option);
  }
);

type FeatureBoot = FeatureBootResult;

const scheduleEntries = (
  boot: FeatureBoot
): readonly {
  readonly definition: ScheduleDefinition;
  readonly name: string;
}[] =>
  boot.scheduleRegistry.entries.map((entry) => ({
    definition: entry.value,
    name: entry.name,
  }));

const unavailableError: ScheduleUnavailableErrorBody = {
  error: UNAVAILABLE_ERROR,
};

const unknownScheduleError = (
  boot: FeatureBoot,
  name: string
): UnknownScheduleErrorBody => ({
  availableScheduleIds: boot.scheduleRegistry.entries.map(
    (entry) => entry.name
  ),
  error: `Unknown schedule "${name}".`,
});

// A row the read drops leaves no other trace, so hand the reads a logger built
// from the ambient context. `None` outside a logging runtime rather than a
// wrapped noop, so "nothing is listening" reads the same here as it does at
// `latestRunsByScheduleId`'s own default and the reads can skip the breadcrumb
// entirely.
const scheduleRunLogger = Effect.fn("RuntimeHttp.scheduleRunLogger")(
  function* () {
    const context = yield* Effect.context();
    return featureLoggerOptionFromContext(context, "schedule:run-history");
  }
);

const loadLatestRuns = Effect.fn("RuntimeHttp.loadLatestRuns")(function* (
  boot: FeatureBoot
) {
  const store = yield* boot.dbRegistry.default.pipe(Effect.option);
  if (store._tag === "None") {
    return EMPTY_RUNS;
  }
  const logger = yield* scheduleRunLogger();
  return yield* latestRunsByScheduleId(store.value, logger).pipe(
    Effect.orElseSucceed(() => EMPTY_RUNS)
  );
});

const loadRuns = Effect.fn("RuntimeHttp.loadRuns")(function* (
  boot: FeatureBoot,
  name: string,
  limit: number
) {
  const store = yield* boot.dbRegistry.default.pipe(Effect.option);
  if (store._tag === "None") {
    return EMPTY_RUN_LIST;
  }
  const logger = yield* scheduleRunLogger();
  return yield* listScheduleRuns(store.value, {
    limit,
    logger,
    scheduleId: name,
  }).pipe(Effect.orElseSucceed(() => EMPTY_RUN_LIST));
});

/**
 * `GET /api/schedules` body: every schedule with its next fire and most recent
 * run. Fails with the tag-free unavailable struct (encoded at 500 by the
 * declaring HttpApi endpoint) when no features root / boot is available.
 */
const listSchedulesBody = Effect.fn("RuntimeHttp.listSchedulesBody")(function* (
  featuresRoot: string | undefined
) {
  const boot = yield* inspectFeatureBoot(featuresRoot);
  if (boot._tag === "None") {
    return yield* Effect.fail(unavailableError);
  }

  const now = yield* Clock.currentTimeMillis;
  const lastRuns = yield* loadLatestRuns(boot.value);
  const entries = scheduleEntries(boot.value);
  const schedules = yield* buildScheduleSummaries(entries, now, lastRuns);
  return { schedules };
});

/**
 * `GET /api/schedules/:name` body: one schedule plus its recent runs. Fails with
 * the unknown-schedule struct (404) for an unknown name, or the unavailable
 * struct (500) when boot is unavailable.
 */
const scheduleDetailBody = Effect.fn("RuntimeHttp.scheduleDetailBody")(
  function* (featuresRoot: string | undefined, name: string) {
    const boot = yield* inspectFeatureBoot(featuresRoot);
    if (boot._tag === "None") {
      return yield* Effect.fail(unavailableError);
    }

    const definition = yield* boot.value.scheduleRegistry
      .get(name)
      .pipe(Effect.option);
    if (definition._tag === "None") {
      return yield* Effect.fail(unknownScheduleError(boot.value, name));
    }

    const now = yield* Clock.currentTimeMillis;
    const runs = yield* loadRuns(boot.value, name, DEFAULT_RUN_LIMIT);
    const summary = yield* buildScheduleSummary(
      {
        definition: definition.value,
        name,
      },
      now,
      runs[0]
    );
    return {
      runs,
      schedule: summary,
    };
  }
);

/**
 * `GET /api/schedules/:name/runs` body: a schedule's recent fire history, newest
 * first. Same 404/500 failure structs as {@link scheduleDetailBody}.
 */
const scheduleRunsBody = Effect.fn("RuntimeHttp.scheduleRunsBody")(function* (
  featuresRoot: string | undefined,
  name: string,
  limit: number
) {
  const boot = yield* inspectFeatureBoot(featuresRoot);
  if (boot._tag === "None") {
    return yield* Effect.fail(unavailableError);
  }

  const definition = yield* boot.value.scheduleRegistry
    .get(name)
    .pipe(Effect.option);
  if (definition._tag === "None") {
    return yield* Effect.fail(unknownScheduleError(boot.value, name));
  }

  const runs = yield* loadRuns(boot.value, name, limit);
  return {
    runs,
    scheduleId: name,
  };
});

export {
  parseRunLimit,
  listSchedulesBody,
  scheduleDetailBody,
  scheduleRunsBody,
};
