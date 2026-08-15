// Split from `daemon-invoke.ts` so the invoke pipeline reads as one flow: this
// is the "a run died, render it as terminal events" leg, used by both the
// runner-error catch and the outer stream catch.
import type { Crypto } from "effect";

import { Effect, Option, Ref, Stream } from "effect";

import type {
  RuntimeJournalError,
  RuntimeValidationError,
} from "../../../../../contracts/internal/src/errors.ts";
import type { AgentRunnerError } from "../../agent-runner/service.ts";
import type { DaemonAuditLoggerShape } from "../core/audit-logger.ts";
import type { AnnouncedRun } from "../core/failure.ts";
import type {
  AgentRuntimeEvent,
  RouteKitEvalDaemonServices,
  RuntimeCommand,
  RuntimeStreamEvent,
} from "../core/types.ts";

import { AgentRuntimeEventTag } from "../../../../../contracts/author/src/index.ts";
import { RuntimeStreamEventTag } from "../../../../../contracts/internal/src/runtime/protocol-tags.ts";
import { makeAuditStreamEvent } from "../core/audit-format.ts";
import { makeRuntimeAuditEvent } from "../core/audit-logger.ts";
import { makeRuntimeFailureEvents } from "../core/failure.ts";
import { makeRuntimeStreamEvents } from "../streams/stream-events.ts";
import {
  formatSafeErrorDiagnostic,
  formatUnknownError,
} from "../../../../../utils/core/src/error-formatting.ts";

export type AppendRuntimeEvent = (
  event: AgentRuntimeEvent
) => Effect.Effect<
  readonly RuntimeStreamEvent[],
  RuntimeJournalError | RuntimeValidationError
>;

/**
 * Render a failure that escaped the agent stream (journal append, session
 * store, audit log) as terminal runtime events. Letting it escape would error
 * the HTTP body after the 200 headers are out, which clients can only read as
 * an opaque mid-stream decode error. These events stay unjournaled since the
 * journal may be the failing dependency.
 */
export const makeUnjournaledFailureStream = (input: {
  readonly command: RuntimeCommand;
  readonly cwd: string;
  readonly error: unknown;
  readonly announcedRun: Ref.Ref<Option.Option<AnnouncedRun>>;
  readonly services: RouteKitEvalDaemonServices;
}): Stream.Stream<RuntimeStreamEvent, RuntimeJournalError> =>
  Stream.fromEffect(
    // The events carry the code's fixed summary and nothing journals this
    // path — the journal may be what failed — so the log is the only place the
    // original text survives at all.
    Effect.logError(
      `Unjournaled invocation failure: ${formatSafeErrorDiagnostic(input.error)}`
    ).pipe(
      Effect.andThen(Ref.get(input.announcedRun)),
      Effect.flatMap((announced) =>
        makeRuntimeFailureEvents({
          announcedRun: Option.getOrUndefined(announced),
          command: input.command,
          crypto: input.services.crypto,
          cwd: input.cwd,
          error: input.error,
        })
      )
    )
  ).pipe(
    Stream.flatMap((events) => Stream.fromIterable(events)),
    Stream.map((event) => makeRuntimeStreamEvents(event)),
    Stream.flatMap((events) => Stream.fromIterable(events))
  );

/**
 * Remember the run a `run.started` just opened, so a later failure can join it
 * instead of opening a second one. Only a real `run.started` counts: recording
 * every element would let the leading `audit.event` of a failure stream stand
 * in for the announcement. Latest wins, because one command can hold several
 * runs (native compact, rollover) and the failure belongs to the newest.
 */
// `eventId` is `runId:eventSequence`; anything else leaves the counter alone.
const eventSequenceOf = (eventId: string): number => {
  const parsed = Number(eventId.slice(eventId.lastIndexOf(":") + 1));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

export const rememberAnnouncedRun = (
  announcedRun: Ref.Ref<Option.Option<AnnouncedRun>>,
  event: RuntimeStreamEvent
): Effect.Effect<void> => {
  if (event.type !== RuntimeStreamEventTag.RuntimeEvent) {
    return Effect.void;
  }
  const { eventId, runId, turnId } = event.event;
  if (event.event.type === AgentRuntimeEventTag.RunStarted) {
    return runId === undefined || turnId === undefined
      ? Effect.void
      : Ref.set(
          announcedRun,
          Option.some({
            eventSequence: eventSequenceOf(eventId),
            runId,
            turnId,
          })
        );
  }
  // Every later event of the announced run pushes its id counter along, so a
  // failure that joins the run picks up after the last id it used.
  return Ref.update(
    announcedRun,
    Option.map((announced) =>
      announced.runId === runId
        ? {
            ...announced,
            eventSequence: eventSequenceOf(eventId),
          }
        : announced
    )
  );
};

export const makeRuntimeFailureStream = (input: {
  readonly appendRuntimeEvent: AppendRuntimeEvent;
  readonly command: RuntimeCommand;
  readonly crypto: Crypto.Crypto;
  readonly cwd: string;
  readonly error: AgentRunnerError;
  /** The run the client already saw opened, when there is one (ROUTEKIT_EVAL-846). */
  readonly announcedRun: AnnouncedRun | undefined;
  readonly logger: DaemonAuditLoggerShape;
}): Stream.Stream<
  RuntimeStreamEvent,
  RuntimeJournalError | RuntimeValidationError
> =>
  Stream.unwrap(
    makeRuntimeAuditEvent(
      {
        commandId: input.command.commandId,
        detail: formatUnknownError(input.error),
        level: "error",
        message: "agent command failed",
        name: "command.failed",
      },
      input.crypto
    ).pipe(
      Effect.map((audit) =>
        Stream.fromEffect(input.logger.log(audit)).pipe(
          Stream.map(() => makeAuditStreamEvent(audit)),
          Stream.concat(
            Stream.fromEffect(
              makeRuntimeFailureEvents({
                command: input.command,
                crypto: input.crypto,
                cwd: input.cwd,
                error: input.error,
                announcedRun: input.announcedRun,
              })
            ).pipe(
              Stream.flatMap((events) => Stream.fromIterable(events)),
              Stream.mapEffect(input.appendRuntimeEvent),
              Stream.flatMap((events) => Stream.fromIterable(events))
            )
          )
        )
      )
    )
  );

/**
 * The runner-error catch: render a harness failure against the run the client
 * already saw opened, as recorded by `rememberAnnouncedRun`. Curried so the
 * invoke pipeline can hand it to `Stream.catchIf` as one expression.
 */
export const catchAnnouncedRunnerFailure =
  (input: {
    readonly announcedRun: Ref.Ref<Option.Option<AnnouncedRun>>;
    readonly appendRuntimeEvent: AppendRuntimeEvent;
    readonly command: RuntimeCommand;
    readonly crypto: Crypto.Crypto;
    readonly cwd: string;
    readonly logger: DaemonAuditLoggerShape;
  }) =>
  (
    error: AgentRunnerError
  ): Stream.Stream<
    RuntimeStreamEvent,
    RuntimeJournalError | RuntimeValidationError
  > =>
    Stream.unwrap(
      Effect.map(Ref.get(input.announcedRun), (announced) =>
        makeRuntimeFailureStream({
          announcedRun: Option.getOrUndefined(announced),
          appendRuntimeEvent: input.appendRuntimeEvent,
          command: input.command,
          crypto: input.crypto,
          cwd: input.cwd,
          error,
          logger: input.logger,
        })
      )
    );
