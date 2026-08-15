import { Effect, Option, Ref, Schema } from "effect";

import type { PiUnknownEvent } from "../native/protocol.ts";
import type { PiExtensionUiRequest, PiKnownSessionEvent } from "../native/schema.ts";
import type { AgentAdapterEvent } from "../../../../../contracts/internal/src/runtime/agent-adapter-event.ts";

import { UsageBearingPiMessage } from "../native/schema.ts";
import { PiUsage } from "../native/usage.ts";
import { unknownNativeEventDiagnostic } from "../diagnostics.ts";
import { makeAgentEventReporter } from "../../../../../engine/agent-events/src/diagnostics.ts";

import type { PiUnsupportedBlockingEventError } from "./elicitation.ts";

import { projectPiElicitation } from "./elicitation.ts";
import { projectPiObservation } from "./observation.ts";
import { projectPiSessionUpdate } from "./session-update.ts";

type PiProjectableEvent =
  | PiExtensionUiRequest
  | PiKnownSessionEvent
  | PiUnknownEvent;
type PiProjector = (
  event: PiProjectableEvent,
  cumulativeCost?: Ref.Ref<number>
) => Effect.Effect<
  readonly AgentAdapterEvent[],
  PiUnsupportedBlockingEventError
>;

const makePiProjectorWithReporter = (
  reportUnknown: (
    nativeEvent: string,
    diagnosticHarness?: string
  ) => Effect.Effect<void>,
  roundUsageSeen: Ref.Ref<boolean>
): PiProjector =>
  Effect.fn("PiProjector.project")(function* (
    event: PiProjectableEvent,
    cumulativeCost?: Ref.Ref<number>
  ) {
    if ("_tag" in event) {
      // A native event whose top-level type this adapter does not model.
      yield* reportUnknown(event.type, event.diagnosticHarness);
      return [];
    }
    if (event.type === "extension_ui_request") {
      const elicitation = yield* projectPiElicitation(event);
      if (elicitation !== undefined) {
        return [];
      }
      // A recognized but non-blocking UI method ACP does not surface.
      yield* reportUnknown(`extension_ui_request.${event.method}`);
      return [];
    }
    if (event.type === "turn_start") {
      yield* Ref.set(roundUsageSeen, false);
    }
    const isUsageEvent =
      event.type === "message_end" || event.type === "turn_end";
    const hasRoundUsage = isUsageEvent ? yield* Ref.get(roundUsageSeen) : false;
    const currentCost =
      cumulativeCost === undefined ? 0 : yield* Ref.get(cumulativeCost);
    const projected = [
      ...projectPiSessionUpdate(event, currentCost, !hasRoundUsage),
      ...projectPiObservation(event),
    ];
    const projectedUsage = projected.some(
      (projectedEvent) =>
        projectedEvent.event === "acp.session_update" &&
        projectedEvent.update.sessionUpdate === "usage_update"
    );
    if (projectedUsage) {
      yield* Ref.set(roundUsageSeen, true);
    }
    if (cumulativeCost !== undefined && isUsageEvent && projectedUsage) {
      const message = Option.getOrUndefined(
        Schema.decodeUnknownOption(UsageBearingPiMessage)(event.message)
      );
      const messageCost = Option.getOrUndefined(
        Schema.decodeUnknownOption(PiUsage)(message?.usage)
      )?.cost?.total;
      if (messageCost !== undefined && messageCost > 0) {
        yield* Ref.update(cumulativeCost, (cost) => cost + messageCost);
      }
    }
    return projected;
  });

const makePiProjector = Effect.gen(function* () {
  const report = yield* makeAgentEventReporter;
  const roundUsageSeen = yield* Ref.make(false);
  return makePiProjectorWithReporter(
    (nativeEvent, diagnosticHarness) =>
      report(unknownNativeEventDiagnostic(nativeEvent, diagnosticHarness)),
    roundUsageSeen
  );
});

export { makePiProjector };
