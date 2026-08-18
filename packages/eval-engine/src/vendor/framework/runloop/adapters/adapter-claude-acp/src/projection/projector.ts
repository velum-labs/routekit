import { Effect } from "effect";

import type { ClaudeUnknownEvent } from "../native/protocol.ts";
import type { ClaudeInbound } from "../native/schema.ts";
import type { AgentAdapterEvent } from "../../../../../contracts/internal/src/runtime/agent-adapter-event.ts";

import { unknownNativeEventDiagnostic } from "../diagnostics.ts";
import { makeAgentEventReporter } from "../../../../../engine/agent-events/src/diagnostics.ts";

import type { ClaudeUnsupportedElicitationError } from "./elicitation.ts";

import { projectClaudeElicitation } from "./elicitation.ts";
import { projectClaudeObservation } from "./observation.ts";
import { projectClaudeSessionUpdate } from "./session-update.ts";

type ClaudeProjectableEvent = ClaudeInbound | ClaudeUnknownEvent;
type ClaudeProjector = (
  event: ClaudeProjectableEvent
) => Effect.Effect<
  readonly AgentAdapterEvent[],
  ClaudeUnsupportedElicitationError
>;

const makeClaudeProjectorWithReporter = (
  reportUnknown: (
    nativeEvent: string,
    diagnosticHarness?: string
  ) => Effect.Effect<void>
): ClaudeProjector =>
  Effect.fn("ClaudeProjector.project")(function* (
    event: ClaudeProjectableEvent
  ) {
    if ("_tag" in event) {
      // A native record whose top-level type this adapter does not model.
      yield* reportUnknown(event.type, event.diagnosticHarness);
      return [];
    }
    if (event.type === "control_request") {
      // A blocking control_request is normally handled by the adapter's
      // elicitation path; the standalone projector still projects it so an
      // unrepresentable request surfaces (it fails) rather than being ignored.
      yield* projectClaudeElicitation(event);
      return [];
    }
    // Both arms guard disjoint event types and yield nothing otherwise, so
    // concatenating them projects each known session event exactly once and
    // leaves the rest (result, init banners…) as no output.
    return [
      ...projectClaudeSessionUpdate(event),
      ...projectClaudeObservation(event),
    ];
  });

const makeClaudeProjector = Effect.gen(function* () {
  const report = yield* makeAgentEventReporter;
  return makeClaudeProjectorWithReporter((nativeEvent, diagnosticHarness) =>
    report(unknownNativeEventDiagnostic(nativeEvent, diagnosticHarness))
  );
});

export { makeClaudeProjector };
