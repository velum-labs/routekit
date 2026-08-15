import type { Layer } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Match, Stream } from "effect";

import type { PiNativeConnection } from "./native/connection.ts";
import type { PiAdapterConfig } from "./config.ts";
import type { PiSessionRegistry } from "./session-registry.ts";
import type { AgentAdapterObservation } from "../../../../contracts/internal/src/runtime/agent-adapter-event.ts";
import type { AgentEventDiagnostic } from "../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";
import type { LoggerShape } from "../../../../contracts/internal/src/runtime/services.ts";

import { makePiNativeConnection } from "./native/connection.ts";
import { makePiAcpClientRequestHandler } from "./adapter.ts";
import { makePiSessionRegistry } from "./session-registry.ts";
import { MAX_DIAGNOSTIC_TEXT_LENGTH } from "../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";
import { startAcpPeer } from "../../../../engine/acp-adapter-kit/src/selected-peer.ts";
import { makeAcpTransportPair } from "../../../../engine/acp-adapter-kit/src/transport-pair.ts";
import { layerAgentEventDiagnostics } from "../../../../engine/agent-events/src/diagnostics.ts";

const PI_HARNESS = "pi";

interface SelectedPiPeerOptions {
  readonly config: PiAdapterConfig;
  readonly diagnosticsLogger: LoggerShape;
  readonly processServices?: Layer.Layer<ChildProcessSpawner> | undefined;
  readonly sessions: PiSessionRegistry;
}

/**
 * Retry/compaction observations and Pi's own stderr never cross the ACP wire
 * (ORI-423 keeps them outside `AcpSessionUpdate`), so this adapter is the
 * composition root that gives them a real, process-external destination:
 * the daemon's own stderr, through the shared runtime-io logger primitives.
 */
const reportPiDiagnostic = (
  diagnostic: AgentEventDiagnostic,
  logger: LoggerShape
): Effect.Effect<void> =>
  Match.value(diagnostic).pipe(
    Match.tag("UnknownNativeEventDiagnostic", (unrecognized) =>
      logger.warn("Pi native event was not recognized", {
        harness: unrecognized.harness,
        nativeEvent: unrecognized.nativeEvent,
      })
    ),
    Match.tag("MalformedNativeEventDiagnostic", (malformed) =>
      logger.warn("Pi native event did not decode", {
        detail: malformed.detail,
        harness: malformed.harness,
        nativeEvent: malformed.nativeEvent,
      })
    ),
    Match.exhaustive
  );

const reportPiObservation = (
  observation: AgentAdapterObservation,
  logger: LoggerShape
): Effect.Effect<void> =>
  logger.info(`Pi adapter observation: ${observation.event}`, {
    ...observation,
  });

/** Drains Pi's own stderr so it is never silently discarded. These are raw
 * process log lines, not native protocol events, so they get their own log
 * surface rather than being disguised as malformed-event diagnostics. */
const drainNativeStderr = (
  native: PiNativeConnection,
  logger: LoggerShape
): Effect.Effect<void> =>
  native.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.runForEach((line) =>
      logger.warn("Pi wrote to stderr", {
        harness: PI_HARNESS,
        line: line.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH),
      })
    ),
    // Peer exit can leave the stderr pipe open without EOF; stop draining when
    // the process exit is observed so scoped teardown cannot hang on this fiber.
    Effect.race(native.exit.pipe(Effect.asVoid)),
    Effect.ignore
  );

const makeSelectedPiAcpPeer = Effect.fn("PiAcpPeer.makeSelected")(function* (
  options: SelectedPiPeerOptions
) {
  const {
    config,
    diagnosticsLogger,
    processServices = NodeServicesLayer,
    sessions,
  } = options;
  const native = yield* makePiNativeConnection(config).pipe(
    Effect.provide(processServices)
  );
  const bridge = yield* makePiAcpClientRequestHandler(
    native,
    (observation) => reportPiObservation(observation, diagnosticsLogger),
    sessions
  ).pipe(
    Effect.provide(
      layerAgentEventDiagnostics((diagnostic) =>
        reportPiDiagnostic(diagnostic, diagnosticsLogger)
      )
    )
  );
  return yield* startAcpPeer({
    bridge,
    drainStderr: drainNativeStderr(native, diagnosticsLogger),
    nativeShutdown: native.shutdown,
    pair: yield* makeAcpTransportPair,
  });
});

export {
  makePiSessionRegistry,
  makeSelectedPiAcpPeer,
  reportPiDiagnostic,
  reportPiObservation,
};
export type { PiSessionRegistry };
