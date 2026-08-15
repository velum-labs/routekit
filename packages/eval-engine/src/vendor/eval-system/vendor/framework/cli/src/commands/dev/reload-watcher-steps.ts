import { Effect, HashSet, Option, Ref } from "effect";

import type { CliIoShape } from "../../../../contracts/internal/src/cli/cli-io.ts";
import type {
  CliIoError,
  RuntimeServerError,
} from "../../../../contracts/internal/src/errors.ts";
import type { FeatureBootResult } from "../../../../runloop/local/src/feature-boot/types.ts";
import type { FeatureRuntimeShape } from "../../../../runloop/local/src/feature-runtime/service.ts";
import type { ReloadDrainResult } from "../../../../runloop/local/src/reload/coordinator.ts";
import type { WatcherDeps } from "./reload-watcher-snapshot.ts";

import {
  formatError,
  formatHint,
  formatInfo,
  formatSuccess,
  formatWarning,
} from "../../../../contracts/internal/src/cli/cli-messages.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { formatBootDiagnostic } from "../../../../runloop/local/src/feature-boot/diagnostics.ts";
import { FeatureRuntime } from "../../../../runloop/local/src/feature-runtime/service.ts";
import { ReloadCoordinator } from "../../../../runloop/local/src/reload/coordinator.ts";
import {
  analyzeReloadGeneration,
  formatReloadAnalysis,
  isIgnoredReloadPath,
} from "./reload.ts";
import { notifyAppliedReloadObserver } from "./reload-observer.ts";
import {
  materializeSnapshot,
  materializeThenCommit,
} from "./reload-watcher-commit.ts";
import { formatDrainResult } from "./reload-watcher-diagnostics.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const EMPTY_COUNT = 0;

const LAST_GOOD_RUNTIME_ACTIVE = "kept the last working version running";

const INITIAL_BOOT_HINT =
  "Fix the feature errors above, then save again to retry.";

const runWithFeatureRuntime = Effect.fn("runWithFeatureRuntime")(function* <
  Value,
>(
  deps: WatcherDeps,
  run: (
    runtime: FeatureRuntimeShape
  ) => Effect.Effect<Value, RuntimeServerError>
) {
  return yield* Effect.gen(function* () {
    const runtime = yield* FeatureRuntime;
    return yield* run(runtime);
  }).pipe(Effect.provide(deps.daemonContext));
});

// An agent editing its own features mid-run must never have the reload interrupt
// that run, so wait for the run boundary before swapping. The drain timeout is a
// backstop for hung runs, not the routine path.
const awaitRunBoundaryEffect = Effect.fn("DevReloadWatcher.awaitRunBoundary")(
  function* (deps: WatcherDeps, drainTimeoutMs: number) {
    const coordinator = yield* ReloadCoordinator;
    const activeCount = yield* coordinator.activeCount;
    if (activeCount > EMPTY_COUNT) {
      yield* deps.cliIo.writeStderr(
        `${formatInfo(`reload: waiting for ${activeCount} in-flight run(s) to finish before swapping`)}\n`
      );
    }
    return yield* coordinator.drain({ timeoutMs: drainTimeoutMs });
  }
);

const awaitRunBoundary = (
  deps: WatcherDeps,
  drainTimeoutMs: number
): Effect.Effect<ReloadDrainResult, CliIoError> =>
  awaitRunBoundaryEffect(deps, drainTimeoutMs).pipe(
    Effect.provide(deps.daemonContext)
  );

const resumeReloadInvocations = Effect.fn("resumeReloadInvocations")(function* (
  deps: WatcherDeps
) {
  yield* Effect.gen(function* () {
    const coordinator = yield* ReloadCoordinator;
    yield* coordinator.resumeInvocations;
  }).pipe(Effect.provide(deps.daemonContext), Effect.ignore);
});

const writeInitialBootWarnings = (
  cliIo: CliIoShape,
  boot: FeatureBootResult
): Effect.Effect<void, CliIoError> =>
  Effect.forEach(
    boot.structuredDiagnostics.filter(
      (diagnostic) => diagnostic.level === "warning"
    ),
    (diagnostic) =>
      cliIo.writeStderr(
        `${formatWarning(`reload: ${formatBootDiagnostic(diagnostic)}`)}\n`
      ),
    { discard: true }
  );

const formatBootDiagnostics = (boot: FeatureBootResult): readonly string[] => {
  const structured = boot.structuredDiagnostics
    .filter((diagnostic) => diagnostic.level === "error")
    .map(formatBootDiagnostic);
  return structured.length > EMPTY_COUNT ? structured : boot.diagnostics;
};

const writeReloadDiagnostics = (
  cliIo: CliIoShape,
  diagnostics: readonly string[]
): Effect.Effect<void, CliIoError> =>
  Effect.forEach(
    diagnostics,
    (diagnostic) =>
      cliIo.writeStderr(`${formatHint(`reload: ${diagnostic}`)}\n`),
    {
      discard: true,
    }
  );

// Fails with a `CliFailureError` only when the initial boot leaves nothing
// runnable (`FeatureRuntime.boot` already rejects that) or its snapshot cannot
// be materialized. A boot that is merely degraded starts the watcher: refusing
// to start would mean one stale feature blocks work on every other feature,
// which is exactly what the watcher exists to unblock. The diagnostics are
// written to stderr and the fix arrives as a normal reload.
const bootstrapInitialReload = Effect.fn(
  "DevReloadWatcher.bootstrapInitialReload"
)(function* (deps: WatcherDeps) {
  const initialBoot = yield* runWithFeatureRuntime(deps, (runtime) =>
    runtime.boot(deps.featuresRoot)
  ).pipe(
    Effect.tapError((error) =>
      deps.cliIo.writeStderr(
        `${formatError(`reload: initial boot failed for ${deps.featuresRoot}: ${formatUnknownError(error)}`)}\n`
      )
    ),
    Effect.mapError(
      (error) =>
        new CliFailureError({
          detail: `Initial feature boot failed for ${deps.featuresRoot}: ${formatUnknownError(error)}`,
          hint: INITIAL_BOOT_HINT,
        })
    )
  );

  if (!initialBoot.valid) {
    yield* deps.cliIo.writeStderr(
      `${formatError(`reload: initial boot degraded for ${deps.featuresRoot}; the contributions below are unavailable until they are fixed`)}\n`
    );
    yield* writeReloadDiagnostics(
      deps.cliIo,
      formatBootDiagnostics(initialBoot)
    );
  }

  yield* writeInitialBootWarnings(deps.cliIo, initialBoot);
  yield* materializeSnapshot(deps, initialBoot).pipe(
    Effect.tapError((error) =>
      deps.cliIo.writeStderr(
        `${formatError(`reload: snapshot materialization failed for ${deps.featuresRoot}: ${formatUnknownError(error)}`)}\n`
      )
    ),
    Effect.mapError(
      (error) =>
        new CliFailureError({
          detail: `Initial feature boot snapshot failed for ${deps.featuresRoot}: ${formatUnknownError(error)}`,
          hint: INITIAL_BOOT_HINT,
        })
    )
  );
  yield* Ref.set(deps.lastGoodBoot, Option.some(initialBoot));
  yield* deps.cliIo.writeStderr(
    `${formatSuccess(`reload: loaded features from ${deps.featuresRoot}`)}\n`
  );
});

const writeReloadRejection = Effect.fn("DevReloadWatcher.writeReloadRejection")(
  function* (
    cliIo: CliIoShape,
    input: {
      readonly analysis: string;
      readonly diagnostics: readonly string[];
      readonly drain?: string;
    }
  ) {
    const drain = input.drain === undefined ? "" : `; ${input.drain}`;
    yield* cliIo.writeStderr(
      `${formatError(`reload: rejected — ${input.analysis}${drain}; ${LAST_GOOD_RUNTIME_ACTIVE}`)}\n`
    );
    yield* writeReloadDiagnostics(cliIo, input.diagnostics);
  }
);

/**
 * Deliberately asymmetric with {@link bootstrapInitialReload}: the initial boot
 * proceeds while degraded, a reload does not commit unless the new boot is
 * clean.
 *
 * This gate is intentionally stricter than RFC 0008 reload transaction, which
 * wants edit-mode validation lenient: a disabled contribution inside an
 * otherwise-composable affected set should drop with a diagnostic and the reload
 * should still apply, with a reject reserved for an affected set that cannot be
 * composed at all. Rejecting on any `boot.valid === false` is broader than that.
 * The strictness is the status quo this PR did not change, not a rule the RFC
 * mandates.
 *
 * Known consequence: a feature that stays broken keeps every later reload
 * `valid === false`, because a partial reload reuses unaffected features
 * verbatim, so edits to healthy features do not take effect until the broken one
 * is fixed. `routekit-eval code` sets `watchReloads: false` and never reaches this path, so
 * the runtime still boots and serves turns; this costs hot reload in `routekit-eval dev`,
 * not the ability to run.
 *
 * Narrowing it needs more than swapping in `runtimeFatalBootDiagnostics`. RFC
 * 0008 rejects when an edit invalidates the sole provider of a required
 * contract, and nothing here tracks required contracts, so a blanket lenient
 * gate would be more permissive than the RFC in the case it calls out. The dev
 * smoke fixture pins the current contract for an invalid manifest and a missing
 * dependency, including that the last-good graph keeps serving. Follow-up.
 */
const runPreparedReload = Effect.fn("runPreparedReload")(function* (
  deps: WatcherDeps,
  input: {
    readonly drainTimeoutMs: number;
    readonly paths: readonly string[];
    readonly previousBoot: Option.Option<FeatureBootResult>;
    readonly previousDefinition: FeatureBootResult["definition"] | undefined;
    readonly preReloadAnalysis: ReturnType<typeof analyzeReloadGeneration>;
  }
) {
  yield* deps.cliIo.writeStderr(
    `${formatInfo(`reload: detected changes — ${input.paths.join(", ")}`)}\n`
  );
  const drain = yield* awaitRunBoundary(deps, input.drainTimeoutMs);
  const prepared = yield* runWithFeatureRuntime(deps, (runtime) =>
    runtime.prepareReload(deps.featuresRoot, {
      affectedFeatureIds: input.preReloadAnalysis.affectedFeatureIds,
    })
  );
  const { boot } = prepared;
  const analysis = analyzeReloadGeneration({
    changedPaths: input.paths,
    current: boot.definition,
    ignorePatterns: deps.ignorePatterns,
    previous: input.previousDefinition,
  });
  if (boot.valid) {
    yield* materializeThenCommit(deps, {
      boot,
      commit: prepared.commit,
      previousBoot: input.previousBoot,
    });
    yield* Ref.set(deps.lastGoodBoot, Option.some(boot));
    yield* deps.cliIo.writeStderr(
      `${formatSuccess(`reload: applied — ${formatReloadAnalysis(analysis)}; ${formatDrainResult(drain)}`)}\n`
    );
    return {
      analysis,
      changedPaths: input.paths,
    };
  }
  yield* writeReloadRejection(deps.cliIo, {
    analysis: formatReloadAnalysis(analysis),
    diagnostics: formatBootDiagnostics(boot),
    drain: formatDrainResult(drain),
  });
  return null;
});

export const drainAndReload = Effect.fn("drainAndReload")(function* (
  deps: WatcherDeps,
  drainTimeoutMs: number
) {
  const accumulated = yield* Ref.getAndSet(
    deps.pending,
    HashSet.empty<string>()
  );
  const paths = [...accumulated].toSorted();
  if (
    paths.every((candidate) =>
      isIgnoredReloadPath(candidate, deps.ignorePatterns)
    )
  ) {
    return;
  }

  const previousBoot = yield* Ref.get(deps.lastGoodBoot);
  const previousDefinition = previousBoot.pipe(
    Option.map((boot) => boot.definition),
    Option.getOrUndefined
  );
  const preReloadAnalysis = analyzeReloadGeneration({
    changedPaths: paths,
    ignorePatterns: deps.ignorePatterns,
    previous: previousDefinition,
  });

  const appliedReload = yield* runPreparedReload(deps, {
    drainTimeoutMs,
    paths,
    preReloadAnalysis,
    previousBoot,
    previousDefinition,
  }).pipe(
    Effect.ensuring(resumeReloadInvocations(deps)),
    Effect.catch((error) => {
      const analysis = analyzeReloadGeneration({
        changedPaths: paths,
        ignorePatterns: deps.ignorePatterns,
        previous: previousDefinition,
      });
      return writeReloadRejection(deps.cliIo, {
        analysis: formatReloadAnalysis(analysis),
        diagnostics: [formatUnknownError(error)],
      }).pipe(Effect.as(null));
    })
  );
  if (appliedReload !== null && deps.options.onAppliedReload !== undefined) {
    yield* notifyAppliedReloadObserver(
      deps.cliIo,
      deps.options.onAppliedReload,
      appliedReload
    );
  }
});

export { bootstrapInitialReload };
