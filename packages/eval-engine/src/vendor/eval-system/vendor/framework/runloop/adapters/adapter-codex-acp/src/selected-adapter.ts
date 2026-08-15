import type { Layer } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Match, Stream } from "effect";

import type { CodexNativeConnection } from "./native/connection.ts";
import type { CodexAdapterConfig } from "./config.ts";
import type { AgentAdapterObservation } from "../../../../contracts/internal/src/runtime/agent-adapter-event.ts";
import type { AgentEventDiagnostic } from "../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";
import type { LoggerShape } from "../../../../contracts/internal/src/runtime/services.ts";

import { makeCodexNativeConnection } from "./native/connection.ts";
import { makeCodexAcpClientRequestHandler } from "./adapter.ts";
import { MAX_DIAGNOSTIC_TEXT_LENGTH } from "../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";
import { startAcpPeer } from "../../../../engine/acp-adapter-kit/src/selected-peer.ts";
import { makeAcpTransportPair } from "../../../../engine/acp-adapter-kit/src/transport-pair.ts";
import { layerAgentEventDiagnostics } from "../../../../engine/agent-events/src/diagnostics.ts";

const CODEX_HARNESS = "codex";

const reportCodexDiagnostic = (
  diagnostic: AgentEventDiagnostic,
  logger: LoggerShape
): Effect.Effect<void> =>
  Match.value(diagnostic).pipe(
    Match.tag("UnknownNativeEventDiagnostic", (unrecognized) =>
      logger.warn("Codex native event was not recognized", {
        harness: unrecognized.harness,
        nativeEvent: unrecognized.nativeEvent,
      })
    ),
    Match.tag("MalformedNativeEventDiagnostic", (malformed) =>
      logger.warn("Codex native event did not decode", {
        detail: malformed.detail,
        harness: malformed.harness,
        nativeEvent: malformed.nativeEvent,
      })
    ),
    Match.exhaustive
  );

const reportCodexObservation = (
  observation: AgentAdapterObservation,
  logger: LoggerShape
): Effect.Effect<void> =>
  logger.info(`Codex adapter observation: ${observation.event}`, observation);

const drainNativeStderr = (
  native: CodexNativeConnection,
  logger: LoggerShape
): Effect.Effect<void> =>
  native.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.runForEach((line) =>
      logger.warn("Codex wrote to stderr", {
        harness: CODEX_HARNESS,
        line: line.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH),
      })
    ),
    Effect.ignore
  );

const makeSelectedCodexAcpPeer = Effect.fn("CodexAcpPeer.makeSelected")(
  function* (
    config: CodexAdapterConfig,
    logger: LoggerShape,
    processServices: Layer.Layer<ChildProcessSpawner> = NodeServicesLayer
  ) {
    const native = yield* makeCodexNativeConnection(config).pipe(
      Effect.provide(processServices)
    );
    const bridge = yield* makeCodexAcpClientRequestHandler(
      native,
      config.model,
      {
        reportObservation: (observation) =>
          reportCodexObservation(observation, logger),
        systemPrompt: config.systemPrompt,
      }
    ).pipe(
      Effect.provide(
        layerAgentEventDiagnostics((diagnostic) =>
          reportCodexDiagnostic(diagnostic, logger)
        )
      )
    );
    return yield* startAcpPeer({
      bridge,
      drainStderr: drainNativeStderr(native, logger),
      nativeShutdown: native.shutdown,
      pair: yield* makeAcpTransportPair,
    });
  }
);

export { makeSelectedCodexAcpPeer, reportCodexObservation };
