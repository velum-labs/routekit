import { Cause, Context, Effect, Layer } from "effect";

import type { LoggerShape } from "../../../contracts/internal/src/runtime/services.ts";

import { AgentEventDiagnostic } from "../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";

interface AgentEventDiagnosticsShape {
  readonly report: (diagnostic: AgentEventDiagnostic) => Effect.Effect<void>;
}

class AgentEventDiagnosticsService extends Context.Service<
  AgentEventDiagnosticsService,
  AgentEventDiagnosticsShape
>()("ori/agent-events/AgentEventDiagnostics") {}

const makeAgentEventReporter = Effect.gen(function* () {
  const diagnostics = yield* AgentEventDiagnosticsService;

  return (diagnostic: AgentEventDiagnostic): Effect.Effect<void> =>
    diagnostics
      .report(diagnostic)
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void
        )
      );
});

const layerAgentEventDiagnostics = (
  report: AgentEventDiagnosticsShape["report"]
): Layer.Layer<AgentEventDiagnosticsService> =>
  Layer.succeed(AgentEventDiagnosticsService, { report });

const makeLoggerDiagnosticSink = (
  logger: LoggerShape
): AgentEventDiagnosticsShape["report"] => {
  const diagnosticLogger = logger.child("agent-events");
  return (diagnostic) =>
    diagnosticLogger.warn("Agent adapter compatibility diagnostic", {
      diagnostic: diagnostic._tag,
      harness: diagnostic.harness,
      nativeEvent: diagnostic.nativeEvent,
      ...AgentEventDiagnostic.match(diagnostic, {
        MalformedNativeEventDiagnostic: ({ detail }) => ({ detail }),
        UnknownNativeEventDiagnostic: () => ({}),
      }),
    });
};

export {
  AgentEventDiagnosticsService,
  layerAgentEventDiagnostics,
  makeAgentEventReporter,
  makeLoggerDiagnosticSink,
};
export type AgentEventDiagnostics = AgentEventDiagnosticsService;
export type { AgentEventDiagnosticsShape };
