import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { layer as NodeCryptoLayer } from "@effect/platform-node/NodeCrypto";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer, Match, Stream } from "effect";

import type { ClaudeNativeConnection } from "./native/connection.ts";
import type { ClaudeAdapterConfig } from "./config.ts";
import type { ClaudeSessionRegistry } from "./session-registry.ts";
import type { AgentAdapterObservation } from "../../../../contracts/internal/src/runtime/agent-adapter-event.ts";
import type { AgentEventDiagnostic } from "../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";
import type { LoggerShape } from "../../../../contracts/internal/src/runtime/services.ts";

import { makeClaudeNativeConnection } from "./native/connection.ts";
import { makeClaudeAcpClientRequestHandler } from "./adapter.ts";
import { makeClaudeSessionRegistry } from "./session-registry.ts";
import { MAX_DIAGNOSTIC_TEXT_LENGTH } from "../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";
import { startAcpPeer } from "../../../../engine/acp-adapter-kit/src/selected-peer.ts";
import { makeAcpTransportPair } from "../../../../engine/acp-adapter-kit/src/transport-pair.ts";
import { layerAgentEventDiagnostics } from "../../../../engine/agent-events/src/diagnostics.ts";

const CLAUDE_HARNESS = "claude";

interface SelectedClaudePeerOptions {
  readonly config: ClaudeAdapterConfig;
  readonly diagnosticsLogger: LoggerShape;
  readonly processServices?: Layer.Layer<ChildProcessSpawner>;
  /**
   * The known-session registry the handler consults. Owned by the caller so a
   * registry can outlive one peer: a resource rebuilt from an ownership record
   * spawns a new process, and `restoreState` re-seeds the same registry.
   */
  readonly sessions?: ClaudeSessionRegistry;
}

/**
 * Retry/compaction observations and Claude's own stderr never cross the ACP
 * wire (ROUTEKIT_EVAL-405/423 keep them outside `AcpSessionUpdate`), so this adapter is
 * the composition root that gives them a real, process-external destination:
 * the daemon's own stderr, through the shared runtime-io logger primitives.
 */
const reportClaudeDiagnostic = (
  diagnostic: AgentEventDiagnostic,
  logger: LoggerShape
): Effect.Effect<void> =>
  Match.value(diagnostic).pipe(
    Match.tag("UnknownNativeEventDiagnostic", (unrecognized) =>
      logger.warn("Claude native event was not recognized", {
        harness: unrecognized.harness,
        nativeEvent: unrecognized.nativeEvent,
      })
    ),
    Match.tag("MalformedNativeEventDiagnostic", (malformed) =>
      logger.warn("Claude native event did not decode", {
        detail: malformed.detail,
        harness: malformed.harness,
        nativeEvent: malformed.nativeEvent,
      })
    ),
    Match.exhaustive
  );

const reportClaudeObservation = (
  observation: AgentAdapterObservation,
  logger: LoggerShape
): Effect.Effect<void> =>
  logger.info(`Claude adapter observation: ${observation.event}`, {
    ...observation,
  });

/** Drains Claude's own stderr so it is never silently discarded. These are raw
 * process log lines, not native protocol events, so they get their own log
 * surface rather than being disguised as malformed-event diagnostics. */
const drainNativeStderr = (
  native: ClaudeNativeConnection,
  logger: LoggerShape
): Effect.Effect<void> =>
  native.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.runForEach((line) =>
      logger.warn("Claude wrote to stderr", {
        harness: CLAUDE_HARNESS,
        line: line.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH),
      })
    ),
    Effect.ignore
  );

const makeSelectedClaudeAcpPeer = Effect.fn("ClaudeAcpPeer.makeSelected")(
  function* ({
    config,
    diagnosticsLogger,
    processServices = NodeServicesLayer,
    sessions = makeClaudeSessionRegistry(),
  }: SelectedClaudePeerOptions) {
    const native = yield* makeClaudeNativeConnection(config).pipe(
      Effect.provide(Layer.merge(processServices, NodeCryptoLayer))
    );
    const bridge = yield* makeClaudeAcpClientRequestHandler(
      native,
      (observation) => reportClaudeObservation(observation, diagnosticsLogger),
      sessions
    ).pipe(
      Effect.provide(
        layerAgentEventDiagnostics((diagnostic) =>
          reportClaudeDiagnostic(diagnostic, diagnosticsLogger)
        )
      )
    );
    return yield* startAcpPeer({
      bridge,
      drainStderr: drainNativeStderr(native, diagnosticsLogger),
      nativeShutdown: native.shutdown,
      pair: yield* makeAcpTransportPair,
    });
  }
);

export { makeSelectedClaudeAcpPeer, reportClaudeObservation };
