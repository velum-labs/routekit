import { Context, Effect, Option } from "effect";

import type {
  ApiFeatureContext,
  Chat,
  ChatContribution,
  FeatureLogger,
} from "../../../../contracts/author/src/index.ts";
import type { FeatureConfig } from "../../../../contracts/author/src/feature-config.ts";
import type { StoreResolver } from "../../../../contracts/author/src/stores.ts";
import type { TelemetryObserverShape } from "../../../../contracts/internal/src/runtime/telemetry-observer.ts";
import type { HubPublishRuntime } from "../../../../runloop/local/src/logging/support.ts";
import type { ScheduleRuntimeConfig } from "../../../../runloop/local/src/schedule/runner.ts";
import type { NamedSchedule } from "../../../../runloop/local/src/schedule/types.ts";

import { CliIo, stdoutLineLogger } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { Logger } from "../../../../engine/runtime-io/src/logger.ts";
import { makeChatSuggestionsFromBoot } from "../../../../runloop/local/src/commands/chat-suggestions-boot.ts";
import { formatBootDiagnostic } from "../../../../runloop/local/src/feature-boot/diagnostics.ts";
import { FeatureRuntime } from "../../../../runloop/local/src/feature-runtime/service.ts";
import {
  makeFeatureLogger,
  makeDaemonHubPublish,
  makeSchedulerHubLogger,
} from "../../../../runloop/local/src/logging/support.ts";
import { ScheduleRuntime } from "../../../../runloop/local/src/schedule/types.ts";
import { resolveChatDefaultsFromBoot } from "../tui/chat-defaults.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

/**
 * Inspect the feature boot for a headless runner, surfacing what the plain
 * `Effect.option` swallow used to hide: a failed boot is logged before the
 * runner backs off, and an invalid boot's error diagnostics (a broken `routekit-eval.md`
 * frontmatter that dropped the workspace `model:`, a rejected feature) are
 * printed so the session doesn't silently run on built-in defaults (ROUTEKIT_EVAL-466).
 */
const inspectBootLoudly = Effect.fn("DevCommand.inspectBootLoudly")(function* (
  runtime: FeatureRuntime["Service"],
  featuresRoot: string,
  log: (line: string) => Effect.Effect<void>
) {
  const boot = yield* runtime.inspect(featuresRoot).pipe(
    Effect.tapError((error) =>
      log(
        `[routekit-eval-runtime] feature boot failed for ${featuresRoot}: ${formatUnknownError(error)}`
      )
    ),
    Effect.option
  );
  if (boot._tag === "Some" && !boot.value.valid) {
    const errors = boot.value.structuredDiagnostics.filter(
      (diagnostic) => diagnostic.level === "error"
    );
    yield* log(
      `[routekit-eval-runtime] feature boot has ${errors.length} error diagnostic(s)`
    );
    yield* Effect.forEach(
      errors,
      (diagnostic) =>
        log(`[routekit-eval-runtime] boot: ${formatBootDiagnostic(diagnostic)}`),
      { discard: true }
    );
  }
  return boot;
});

const runtimeLogger = Effect.fn("DevCommand.runtimeLogger")(function* () {
  return Context.getOption(yield* Effect.context(), Logger).pipe(
    Option.map(makeFeatureLogger)
  );
});

const logChatDefaultWarnings = Effect.fn("DevCommand.logChatDefaultWarnings")(
  function* (warnings: readonly string[]) {
    yield* Effect.forEach(warnings, (warning) => Effect.logWarning(warning), {
      discard: true,
    });
  }
);

// Lazily import the schedule runner (it pulls in the heavy chat/agent-runner/index
// subtree via `makeChat`, which a top-level import would drag into the unit
// coverage graph of every module that imports this one — the same lazy-import
// pattern as the reload watcher in session-support.ts), build its runtime, and
// arm the registered schedules.
const armSchedules = Effect.fn("DevCommand.armSchedules")(function* (input: {
  readonly cwd: string;
  readonly featuresRoot: string;
  readonly host: string;
  readonly log: (line: string) => Effect.Effect<void>;
  readonly port: number;
  readonly scheduleLogger: FeatureLogger;
  readonly schedules: readonly NamedSchedule[];
  readonly store: ScheduleRuntimeConfig["store"];
  readonly telemetryObserver?: TelemetryObserverShape | undefined;
  readonly useFor: (featureId: string) => ApiFeatureContext["use"];
}) {
  const { acquireScheduleRuntime, runSchedules } = yield* Effect.promise(
    () => import("../../../../runloop/local/src/schedule/runner.ts")
  );
  const scheduleRuntime = yield* acquireScheduleRuntime({
    cwd: input.cwd,
    featuresRoot: input.featuresRoot,
    host: input.host,
    logger: input.scheduleLogger,
    port: input.port,
    store: input.store,
    telemetryObserver: input.telemetryObserver,
    useFor: input.useFor,
  });
  yield* input.log(
    `[routekit-eval-runtime] arming ${input.schedules.length} schedule(s)`
  );
  // Fire failures are logged by `fireAndRecord`; these are only arming-level
  // problems (a malformed cron, an unknown timezone, a cron that never fires).
  const armErrors = yield* runSchedules(input.schedules).pipe(
    Effect.provideService(ScheduleRuntime, scheduleRuntime)
  );
  for (const armError of armErrors) {
    input.scheduleLogger
      .child(armError.scheduleName)
      .error("schedule could not be armed", armError);
  }
});

/**
 * Arm every registered `schedule` contribution for the running daemon. The
 * scheduler runtime drives fires through the same `/api/invoke` daemon path the
 * chat surface uses, so schedules tick whether or not a TUI is attached. Shared
 * by `routekit-eval start` and `routekit-eval dev`'s headless fallback via `runHeadlessRuntimeSession`.
 *
 * Resolution failures are logged and ignored so a schedule problem never blocks
 * the booted runtime. The scheduler is armed inside the caller's scope via
 * `runSchedules` (acquire/release), so its timers are torn down when the session
 * scope closes. Progress lines go to stdout — the headless runtime has no TUI to
 * corrupt.
 */
const startScheduleContributions = Effect.fn("DevCommand.schedules")(
  function* (input: {
    readonly cwd: string;
    /** Daemon runtime whose log hub `routekit-eval logs` reads; scheduler diagnostics publish here (RFC 0011). */
    readonly daemonRuntime: HubPublishRuntime;
    readonly featuresRoot: string;
    readonly host: string;
    readonly port: number;
    readonly telemetryObserver?: TelemetryObserverShape | undefined;
  }) {
    const cliIo = yield* CliIo;
    const log = stdoutLineLogger(cliIo);
    const scheduleLogger = yield* makeSchedulerHubLogger(
      makeDaemonHubPublish(input.daemonRuntime),
      "schedule"
    );

    const runtime = yield* FeatureRuntime;
    const boot = yield* inspectBootLoudly(runtime, input.featuresRoot, log);
    if (boot._tag === "None") {
      return;
    }

    const schedules = boot.value.scheduleRegistry.entries.map((entry) => ({
      definition: entry.value,
      featureId: entry.featureId,
      name: entry.name,
    }));
    if (schedules.length === 0) {
      return;
    }

    const store = yield* boot.value.dbRegistry.default.pipe(Effect.option);
    if (store._tag === "None") {
      yield* log(
        "[routekit-eval-runtime] schedules registered but no state store is available; skipping scheduler"
      );
      return;
    }

    yield* armSchedules({
      cwd: input.cwd,
      featuresRoot: input.featuresRoot,
      host: input.host,
      log,
      port: input.port,
      scheduleLogger,
      schedules,
      store: store.value,
      telemetryObserver: input.telemetryObserver,
      useFor: (featureId) => boot.value.apiRegistry.contextFor(featureId).use,
    });
  }
);

// The terminal TUI built-in renders to a TTY and blocks on the terminal event
// loop, so it must never be auto-started in a headless session — it is attached
// explicitly with `routekit-eval tui`. Every other chat contribution (a Slack/HTTP bridge
// and the like) starts a background server from `start()` and is safe to run
// headless. Identified by feature id rather than name so a project chat that
// happens to be named "tui" is still started.
const TERMINAL_TUI_CHAT_FEATURE_ID = "@routekit-eval-builtins/chat-tui";

/**
 * Fork one chat contribution's `start()`/`stop()` lifecycle into the caller's
 * scope. Split out of `startChatContributions` so the per-entry acquire/fork
 * plumbing does not inflate that function past the line budget.
 */
const forkChatContributionStart = Effect.fn("DevCommand.chatStart")(
  function* (input: {
    readonly chat: Chat;
    readonly contribution: ChatContribution;
    readonly log: (line: string) => Effect.Effect<void>;
    readonly name: string;
  }) {
    // Fork into the caller's scope: a server contribution's `start()` blocks
    // until `stop()`, so awaiting it inline would deadlock the boot sequence and
    // prevent any later surface from starting. `addFinalizer` runs `stop()` when
    // the session scope closes, mirroring `routekit-eval tui`'s acquire/release lifecycle.
    yield* Effect.acquireRelease(
      Effect.succeed(input.contribution),
      (acquired) => Effect.promise(() => acquired.stop()).pipe(Effect.ignore)
    );
    yield* Effect.forkScoped(
      Effect.tryPromise(() => input.contribution.start(input.chat)).pipe(
        Effect.tapError((error) =>
          input.log(
            `[routekit-eval-runtime] chat "${input.name}" failed: ${formatUnknownError(error)}`
          )
        ),
        Effect.ignore
      )
    );
  }
);

const loadChatDependencies = Effect.all({
  makeChat: Effect.promise(() => import("../../../../runloop/local/src/chat/index.ts")).pipe(
    Effect.map(({ makeChat }) => makeChat)
  ),
  makeCommandRouterFromBoot: Effect.promise(
    () => import("../../../../runloop/local/src/commands/command-router-boot.ts")
  ).pipe(
    Effect.map(({ makeCommandRouterFromBoot }) => makeCommandRouterFromBoot)
  ),
});

/**
 * Start every registered headless `chat` contribution for the running daemon,
 * each in its own forked scope so a server `start()` that blocks until `stop()`
 * does not stall boot and multiple surfaces run concurrently. Chats dial the
 * daemon's `/api/invoke` path through the same `makeChat` handle `routekit-eval tui` uses,
 * so they work whether or not a TUI is attached. Shared by `routekit-eval start` via
 * `runHeadlessRuntimeSession`.
 *
 * The terminal TUI built-in is skipped because it cannot run without a TTY.
 */
const startChatContributions = Effect.fn("DevCommand.chats")(function* (input: {
  readonly config?: FeatureConfig | undefined;
  readonly cwd: string;
  readonly featuresRoot: string;
  readonly host: string;
  readonly port: number;
  readonly runLabel?: string | undefined;
  readonly stores?: StoreResolver | undefined;
}) {
  const log = stdoutLineLogger(yield* CliIo);
  const runtime = yield* FeatureRuntime;
  const boot = yield* inspectBootLoudly(runtime, input.featuresRoot, log);
  if (boot._tag === "None") {
    return;
  }
  const chats = boot.value.chatRegistry.entries.filter(
    (entry) => entry.featureId !== TERMINAL_TUI_CHAT_FEATURE_ID
  );
  if (chats.length === 0) {
    return;
  }
  const { makeChat, makeCommandRouterFromBoot } = yield* loadChatDependencies;
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  const defaults = yield* resolveChatDefaultsFromBoot({
    boot: boot.value,
    harnessName: undefined,
    model: undefined,
  });
  const logger = yield* runtimeLogger();
  yield* logChatDefaultWarnings(defaults.warnings);
  yield* log(`[routekit-eval-runtime] starting ${chats.length} chat surface(s)`);
  for (const entry of chats) {
    const { use } = boot.value.apiRegistry.contextFor(entry.featureId);
    const chat = makeChat({
      commands: makeCommandRouterFromBoot({
        cwd: input.cwd,
        env,
        registry: boot.value.commandRegistry,
        useFor: (providerFeatureId) =>
          boot.value.apiRegistry.contextFor(providerFeatureId).use,
      }),
      config: input.config,
      cwd: input.cwd,
      defaultHarness: defaults.harness,
      defaultModel: defaults.model,
      defaultEffort: defaults.effort,
      ...(Option.isSome(logger)
        ? { logger: logger.value.child(entry.name) }
        : {}),
      featuresRoot: input.featuresRoot,
      host: input.host,
      port: input.port,
      telemetrySurface: input.runLabel ?? "unknown",
      stores: input.stores,
      suggestions: makeChatSuggestionsFromBoot(boot.value),
      use,
    });
    yield* forkChatContributionStart({
      chat,
      contribution: entry.value,
      log,
      name: entry.name,
    });
  }
});

export { startScheduleContributions, startChatContributions };
