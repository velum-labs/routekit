import type { Crypto } from "effect";

import { Clock, Context, Effect, Layer, Option, Stream } from "effect";
import { Stdio } from "effect/Stdio";

import type { RuntimeCommandId } from "../../../../../contracts/internal/src/ids.ts";
import type { GatewayAuthSource } from "../../../../../contracts/internal/src/gateway-auth.ts";
import type { RuntimeJournalEntry } from "../../../../../contracts/internal/src/runtime/journal-entry.ts";
import type { RouteKitEvalDaemonShape } from "./service.ts";

import { RuntimeJournalError } from "../../../../../contracts/internal/src/errors.ts";
import { RuntimeAuditId } from "../../../../../contracts/internal/src/ids.ts";
import { RUNTIME_EVENT_APPENDED_AUDIT_NAME } from "../../../../../contracts/internal/src/runtime/audit-event.ts";
import { formatRuntimeAuditEvent } from "./audit-format.ts";
import { DaemonLogHub } from "../logging/log-hub.ts";

type RuntimeAuditEvent = Parameters<typeof formatRuntimeAuditEvent>[0];

export interface DaemonAuditLoggerShape {
  readonly log: (event: RuntimeAuditEvent) => Effect.Effect<void>;
}

export class DaemonAuditLogger extends Context.Service<
  DaemonAuditLogger,
  DaemonAuditLoggerShape
>()("routekit-eval/runtime/DaemonAuditLogger") {
  static readonly layer = Layer.effect(DaemonAuditLogger)(
    Effect.gen(function* () {
      const stdio = yield* Stdio;
      const hub = yield* DaemonLogHub;

      return DaemonAuditLogger.of({
        log: Effect.fn("DaemonAuditLogger.log")(function* (
          event: RuntimeAuditEvent
        ) {
          const line = formatRuntimeAuditEvent(event);
          yield* hub.publish(line);
          yield* Stream.succeed(`${line}\n`).pipe(
            Stream.run(stdio.stdout({ endOnDone: false })),
            Effect.ignore
          );
        }),
      });
    })
  );
}

/**
 * Audit logger that publishes to the log hub only, never stdout. Used by the
 * split dev session, where the host TUI owns the terminal and raw stdout
 * writes would corrupt the rendered frame.
 */
export const auditHubOnlyLoggerLayer = Layer.effect(DaemonAuditLogger)(
  Effect.gen(function* () {
    const hub = yield* DaemonLogHub;
    return DaemonAuditLogger.of({
      log: Effect.fn("DaemonAuditLogger.log")((event: RuntimeAuditEvent) =>
        hub.publish(formatRuntimeAuditEvent(event))
      ),
    });
  })
);

/**
 * The daemon's audit logging stack: the audit logger plus the log hub it
 * publishes into, exposed together so daemon runtimes get both services.
 * `suppressAuditStdout` keeps the audit log off stdout while a host TUI owns
 * the terminal; lines still reach the hub and `GET /api/logs/stream`.
 */
export const makeDaemonAuditLayer = (options?: {
  readonly suppressAuditStdout?: boolean | undefined;
}): Layer.Layer<DaemonAuditLogger | DaemonLogHub, never, Stdio> =>
  (options?.suppressAuditStdout === true
    ? auditHubOnlyLoggerLayer
    : DaemonAuditLogger.layer
  ).pipe(Layer.provideMerge(DaemonLogHub.layer));

export const makeRuntimeAuditEvent = Effect.fn("Daemon.makeRuntimeAuditEvent")(
  function* (
    input: {
      readonly commandId?: RuntimeCommandId;
      readonly detail?: unknown;
      readonly level?: RuntimeAuditEvent["level"];
      readonly message: string;
      readonly name: string;
    },
    crypto: Crypto.Crypto
  ) {
    const currentTimeMillis = yield* Clock.currentTimeMillis;
    const auditId = yield* crypto.randomUUIDv4.pipe(
      Effect.map(RuntimeAuditId.make),
      Effect.mapError(
        (cause) =>
          new RuntimeJournalError({
            cause,
            detail: "Could not generate runtime audit event id",
            operation: "audit",
          })
      )
    );
    return {
      auditId,
      createdAt: new Date(currentTimeMillis).toISOString(),
      level: input.level ?? "info",
      message: input.message,
      name: input.name,
      // `commandId` and `detail` are `optionalKey` on RuntimeAuditEventSchema,
      // so the contract is "absent", not "present and undefined". Spread the
      // key in only when the caller supplied one.
      ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    };
  }
);

export const logConfiguredAuthSource = (input: {
  readonly authSource: Option.Option<GatewayAuthSource>;
  readonly crypto: Crypto.Crypto;
  readonly logger: DaemonAuditLoggerShape;
}): Effect.Effect<void> => {
  if (Option.isNone(input.authSource)) {
    return Effect.void;
  }
  const authSource = input.authSource.value;
  return makeRuntimeAuditEvent(
    {
      detail: {
        kind: authSource.kind,
        location: authSource.location,
      },
      message: `Gateway auth configured from ${authSource.location}`,
      name: "dev.auth.configured",
    },
    input.crypto
  ).pipe(Effect.andThen(input.logger.log), Effect.ignore);
};

type RuntimeCommand = Parameters<RouteKitEvalDaemonShape["invoke"]>[0];

export const makeCommandClosedEffect = (
  crypto: Crypto.Crypto,
  logger: DaemonAuditLoggerShape,
  command: RuntimeCommand
): Effect.Effect<void> =>
  makeRuntimeAuditEvent(
    {
      commandId: command.commandId,
      message: "agent command stream closed",
      name: "command.closed",
    },
    crypto
  ).pipe(Effect.andThen(logger.log), Effect.ignore);

export const makeRuntimeEventAuditEvent = (
  command: RuntimeCommand,
  entry: RuntimeJournalEntry,
  crypto: Crypto.Crypto
): ReturnType<typeof makeRuntimeAuditEvent> =>
  makeRuntimeAuditEvent(
    {
      commandId: command.commandId,
      detail: {
        entryId: entry.entryId,
        eventId: entry.event.eventId,
        harness: entry.event.harness,
        runId: entry.event.runId,
        sequence: entry.sequence,
        sessionId: entry.event.sessionId,
        turnId: entry.event.turnId,
        type: entry.event.type,
      },
      message: `runtime event ${entry.event.type}`,
      name: RUNTIME_EVENT_APPENDED_AUDIT_NAME,
    },
    crypto
  );
