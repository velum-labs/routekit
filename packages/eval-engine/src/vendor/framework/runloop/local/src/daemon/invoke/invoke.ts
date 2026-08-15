import type { Crypto } from "effect";

import { Effect, Option, Ref, Stream } from "effect";

import type {
  RuntimeJournalError,
  RuntimeReloadInterruptedError,
  RuntimeValidationError,
} from "../../../../../contracts/internal/src/errors.ts";
import type { SessionId } from "../../../../../contracts/internal/src/ids.ts";
import type { AgentRuntimeEvent } from "../../../../../contracts/internal/src/runtime/agent-runtime-event-types.ts";
import type {
  AgentRunnerError,
  AgentRunnerShape,
} from "../../agent-runner/service.ts";
import type { DaemonAuditLoggerShape } from "../core/audit-logger.ts";
import type { AnnouncedRun } from "../core/failure.ts";
import type {
  OriDaemonServices,
  RuntimeCommand,
  RuntimeStreamEvent,
} from "../core/types.ts";
import type { AppendRuntimeEvent } from "./invoke-failure-stream.ts";
import type { RolloverResolution } from "../../event/rollover-stream.ts";
import type { ReloadInvocationLease } from "../../reload/coordinator.ts";

import { TelemetryObserver } from "../../../../../contracts/internal/src/runtime/telemetry-observer.ts";
import { TELEMETRY_SURFACE_INTERNAL } from "../../../../../contracts/internal/src/runtime/telemetry-surface.ts";
import { isAgentRunnerError } from "../../agent-runner/service.ts";
import {
  makeAuditStreamEvent,
  summarizeCommand,
} from "../core/audit-format.ts";
import {
  makeCommandClosedEffect,
  makeRuntimeAuditEvent,
  makeRuntimeEventAuditEvent,
} from "../core/audit-logger.ts";
import { makeRunnerCommand } from "../core/command.ts";
import {
  catchAnnouncedRunnerFailure,
  makeUnjournaledFailureStream,
  rememberAnnouncedRun,
} from "./invoke-failure-stream.ts";
import {
  commandReceivedMessage,
  resolveFork,
} from "./invoke-fork.ts";
import { makeRuntimeStreamEvents } from "../streams/stream-events.ts";
import { stampLineage } from "../../event/fork-thread.ts";
import {
  guardUnresolvedForcedRollover,
  makeRolloverStream,
  resolveRollover,
} from "../../event/rollover-stream.ts";

/** The cancellation a client can request for an in-flight command. */
export interface InvocationCancellation {
  readonly cancelled: Ref.Ref<boolean>;
  readonly signal: Effect.Effect<unknown>;
}
// A run ends early either because the daemon is reloading its features or
// because the client asked for this command to stop; whichever lands first
// interrupts the stream.
const invocationInterrupt = (
  lease: ReloadInvocationLease,
  cancellation: InvocationCancellation | undefined
): Effect.Effect<unknown, RuntimeReloadInterruptedError> =>
  Effect.raceFirst(lease.interrupt, cancellation?.signal ?? Effect.never);
const makeRuntimeEventAppender =
  (
    services: OriDaemonServices,
    command: RuntimeCommand,
    parentSessionId?: SessionId
  ): AppendRuntimeEvent =>
  (event) =>
    // For a spawned run, stamp the parent lineage onto every emitted event
    // (Spawn Thread, RFC 0003) so a subscriber tailing the child reads it.
    services.journal
      .append(
        parentSessionId === undefined
          ? event
          : stampLineage(event, parentSessionId)
      )
      .pipe(
        Effect.tap((entry) => services.sessionStore.apply(entry)),
        Effect.tap((entry) =>
          makeRuntimeEventAuditEvent(command, entry, services.crypto).pipe(
            Effect.andThen(services.logger.log)
          )
        ),
        Effect.map((entry) => makeRuntimeStreamEvents(entry.event))
      );
export const makeAgentInvocationStream = (input: {
  readonly events: ReturnType<AgentRunnerShape["invokeRuntime"]>;
  readonly announcedRun: Ref.Ref<Option.Option<AnnouncedRun>>;
  readonly cancellation: InvocationCancellation | undefined;
  readonly appendRuntimeEvent: AppendRuntimeEvent;
  readonly command: RuntimeCommand;
  readonly crypto: Crypto.Crypto;
  readonly cwd: string;
  readonly lease: ReloadInvocationLease;
  readonly logger: DaemonAuditLoggerShape;
  readonly suppressCommandClosed: boolean;
}): Stream.Stream<
  RuntimeStreamEvent,
  RuntimeJournalError | RuntimeValidationError
> =>
  input.events.pipe(
    Stream.interruptWhen(invocationInterrupt(input.lease, input.cancellation)),
    Stream.mapEffect(input.appendRuntimeEvent),
    Stream.flatMap((runtimeEvents) => Stream.fromIterable(runtimeEvents)),
    Stream.tap((event) => rememberAnnouncedRun(input.announcedRun, event)),
    Stream.catchIf(
      (error) => isAgentRunnerError(error),
      catchAnnouncedRunnerFailure(input)
    ),
    Stream.ensuring(input.lease.end.pipe(Effect.ignore)),
    Stream.ensuring(
      input.suppressCommandClosed
        ? Effect.void
        : makeCommandClosedEffect(input.crypto, input.logger, input.command)
    )
  );
const makeLeasedAgentRuntimeStream = (
  input: {
    readonly appendRuntimeEvent: AppendRuntimeEvent;
    readonly cancellation: InvocationCancellation | undefined;
    readonly command: RuntimeCommand;
    readonly cwd: string;
    readonly services: OriDaemonServices;
    readonly suppressCommandClosed?: boolean;
  },
  lease: ReloadInvocationLease
): Stream.Stream<
  RuntimeStreamEvent,
  RuntimeJournalError | RuntimeValidationError
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // A harness that dies mid-run has already emitted `run.started` /
      // `turn.started`; the failure stream must not announce the run a second
      // time, model-less, as if a duplicate dispatch had happened (ORI-846).
      const announcedRun = yield* Ref.make(Option.none<AnnouncedRun>());
      const events = input.services.runner.invokeRuntime(
        makeRunnerCommand({
          cancellation: input.cancellation,
          command: input.command,
          cwd: input.cwd,
          services: input.services,
        })
      );
      return makeAgentInvocationStream({
        announcedRun,
        appendRuntimeEvent: input.appendRuntimeEvent,
        cancellation: input.cancellation,
        command: input.command,
        crypto: input.services.crypto,
        cwd: input.cwd,
        events,
        lease,
        logger: input.services.logger,
        suppressCommandClosed: input.suppressCommandClosed ?? false,
      });
    })
  );
const makeAgentRuntimeStream = (input: {
  readonly appendRuntimeEvent: AppendRuntimeEvent;
  readonly cancellation: InvocationCancellation | undefined;
  readonly command: RuntimeCommand;
  readonly cwd: string;
  readonly services: OriDaemonServices;
  readonly suppressCommandClosed?: boolean;
}): Stream.Stream<
  RuntimeStreamEvent,
  RuntimeJournalError | RuntimeValidationError
> =>
  Stream.unwrap(
    input.services.reloadCoordinator.beginInvocation.pipe(
      Effect.map((lease) => makeLeasedAgentRuntimeStream(input, lease))
    )
  );
const makeCompactionInvocationStream = (input: {
  readonly appendRuntimeEvent: AppendRuntimeEvent;
  readonly cancellation: InvocationCancellation | undefined;
  readonly command: RuntimeCommand;
  readonly compactionCommand: RuntimeCommand;
  readonly compaction: Stream.Stream<AgentRuntimeEvent, AgentRunnerError>;
  readonly cwd: string;
  readonly services: OriDaemonServices;
}): Stream.Stream<
  RuntimeStreamEvent,
  RuntimeJournalError | RuntimeValidationError | AgentRunnerError
> =>
  Stream.concat(
    Stream.unwrap(
      Effect.gen(function* () {
        const lease = yield* input.services.reloadCoordinator.beginInvocation;
        const announcedRun = yield* Ref.make(Option.none<AnnouncedRun>());
        return makeAgentInvocationStream({
          announcedRun,
          appendRuntimeEvent: input.appendRuntimeEvent,
          cancellation: input.cancellation,
          command: input.compactionCommand,
          crypto: input.services.crypto,
          cwd: input.cwd,
          events: input.compaction,
          lease,
          logger: input.services.logger,
          suppressCommandClosed: true,
        });
      })
    ),
    makeAgentRuntimeStream({
      appendRuntimeEvent: input.appendRuntimeEvent,
      cancellation: input.cancellation,
      command: input.command,
      cwd: input.cwd,
      services: input.services,
    })
  );

const makeRolloverFallbackStream = (input: {
  readonly appendRuntimeEvent: AppendRuntimeEvent;
  readonly cancellation: InvocationCancellation | undefined;
  readonly command: RuntimeCommand;
  readonly cwd: string;
  readonly rollover: RolloverResolution;
  readonly services: OriDaemonServices;
}): Stream.Stream<
  RuntimeStreamEvent,
  RuntimeJournalError | RuntimeValidationError
> =>
  makeRolloverStream({
    appendRuntimeEvent: input.appendRuntimeEvent,
    command: input.command,
    invokeSummary: (prompt) =>
      input.services.runner.invokeRuntime({
        ...makeRunnerCommand({
          cancellation: input.cancellation,
          command: input.command,
          cwd: input.cwd,
          services: input.services,
        }),
        outputSchema: undefined,
        prompt,
        telemetrySurface: TELEMETRY_SURFACE_INTERNAL,
      }),
    makeChildStream: (childCommand) =>
      makeAgentRuntimeStream({
        appendRuntimeEvent: makeRuntimeEventAppender(
          input.services,
          childCommand,
          input.rollover.sessionId
        ),
        cancellation: input.cancellation,
        command: childCommand,
        cwd: input.cwd,
        services: input.services,
      }),
    resolution: input.rollover,
    services: input.services,
  });

const withInternalTelemetry = (command: RuntimeCommand): RuntimeCommand => ({
  ...command,
  telemetrySurface: TELEMETRY_SURFACE_INTERNAL,
});

const makeInvokeAgentStream = (input: {
  readonly appendRuntimeEvent: AppendRuntimeEvent;
  readonly cancellation: InvocationCancellation | undefined;
  readonly command: RuntimeCommand;
  readonly cwd: string;
  readonly rollover: RolloverResolution | null;
  readonly services: OriDaemonServices;
}): Stream.Stream<
  RuntimeStreamEvent,
  RuntimeJournalError | RuntimeValidationError | AgentRunnerError
> => {
  const { appendRuntimeEvent, cancellation, command, cwd, rollover, services } =
    input;
  if (rollover === null) {
    return makeAgentRuntimeStream({
      appendRuntimeEvent,
      cancellation,
      command,
      cwd,
      services,
    });
  }
  const rolloverFallback = makeRolloverFallbackStream({
    appendRuntimeEvent,
    cancellation,
    command,
    cwd,
    rollover,
    services,
  });
  if (
    rollover.plan.trigger !== "automatic" ||
    rollover.plan.cause !== "threshold"
  ) {
    return rolloverFallback;
  }
  const compactionCommand = withInternalTelemetry(command);
  return Stream.unwrap(
    services.runner
      .invokeCompaction(
        makeRunnerCommand({
          cancellation,
          command: compactionCommand,
          cwd,
          services,
        })
      )
      .pipe(
        Effect.map((compaction) => {
          if (Option.isNone(compaction)) {
            return rolloverFallback;
          }
          return makeCompactionInvocationStream({
            appendRuntimeEvent,
            cancellation,
            command,
            compactionCommand,
            compaction: compaction.value,
            cwd,
            services,
          });
        })
      )
  );
};

export const invokeRuntimeCommand = Effect.fn("Daemon.invokeRuntimeCommand")(
  function* (
    services: OriDaemonServices,
    rawCommand: RuntimeCommand,
    cancellation: InvocationCancellation
  ) {
    const resolved = yield* resolveFork(services, rawCommand);
    const { command } = resolved;
    if (resolved.parentSessionId !== undefined) {
      yield* (services.telemetryObserver ?? TelemetryObserver.noop)
        .observe("thread_forked")
        .pipe(Effect.ignore);
    }
    const cwd = command.cwd ?? services.defaultCwd;
    const rollover =
      resolved.parentSessionId === undefined
        ? yield* resolveRollover(services, command)
        : null;
    const commandReceived = yield* makeRuntimeAuditEvent(
      {
        commandId: command.commandId,
        detail: summarizeCommand(command, cwd),
        message: commandReceivedMessage(resolved.parentSessionId, rollover),
        name: "command.received",
      },
      services.crypto
    );
    const agentStream = makeInvokeAgentStream({
      appendRuntimeEvent: makeRuntimeEventAppender(
        services,
        command,
        resolved.parentSessionId
      ),
      cancellation,
      command,
      cwd,
      rollover,
      services,
    });
    // Tracks whether the agent stream got far enough to announce its own run,
    // so the failure path below knows not to announce a second one.
    const announcedRun = yield* Ref.make(Option.none<AnnouncedRun>());

    return Stream.fromEffect(
      guardUnresolvedForcedRollover(command, rollover, services.rollover.mode)
    ).pipe(
      Stream.drain,
      Stream.concat(
        Stream.fromEffect(services.logger.log(commandReceived)).pipe(
          Stream.map(() => makeAuditStreamEvent(commandReceived))
        )
      ),
      Stream.concat(
        agentStream.pipe(
          Stream.tap((event) => rememberAnnouncedRun(announcedRun, event))
        )
      ),
      Stream.catch((error) =>
        makeUnjournaledFailureStream({
          announcedRun,
          command,
          cwd,
          error,
          services,
        })
      )
    );
  }
);
