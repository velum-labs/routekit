import { Effect } from "effect";

import type { CodexUnknownEvent } from "../native/protocol.ts";
import type { CodexKnownSessionEvent } from "../native/schema.ts";
import type { AgentAdapterEvent } from "../../../../../contracts/internal/src/runtime/agent-adapter-event.ts";

import { unknownNativeEventDiagnostic } from "../diagnostics.ts";
import { makeAgentEventReporter } from "../../../../../engine/agent-events/src/diagnostics.ts";

import { projectCodexObservation } from "./observation.ts";
import { projectCodexSessionUpdate } from "./session-update.ts";

type CodexProjectableEvent = CodexKnownSessionEvent | CodexUnknownEvent;
type CodexProjector = (
  event: CodexProjectableEvent
) => Effect.Effect<readonly AgentAdapterEvent[]>;

const makeCodexProjectorWithReporter = (
  reportUnknown: (
    nativeEvent: string,
    diagnosticHarness?: string
  ) => Effect.Effect<void>
): CodexProjector =>
  Effect.fn("CodexProjector.project")(function* (event: CodexProjectableEvent) {
    if ("_tag" in event) {
      // A native notification whose method this adapter does not model.
      yield* reportUnknown(event.method, event.diagnosticHarness);
      return [];
    }
    // Both arms guard disjoint event types and yield nothing otherwise, so
    // concatenating them projects each known session event exactly once and
    // leaves the turn-lifecycle notification (`turn/completed`, handled by
    // the adapter directly) as no output.
    return [
      ...projectCodexSessionUpdate(event),
      ...projectCodexObservation(event),
    ];
  });

const makeCodexProjector = Effect.gen(function* () {
  const report = yield* makeAgentEventReporter;
  return makeCodexProjectorWithReporter((nativeEvent, diagnosticHarness) =>
    report(unknownNativeEventDiagnostic(nativeEvent, diagnosticHarness))
  );
});

export { makeCodexProjector };
