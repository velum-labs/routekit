import { Effect, Option, Schema } from "effect";

import type { AgentEventDiagnostic } from "../../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";
import type { AcpAgentConnectionShape } from "../../../../../engine/acp-agent/src/service.ts";

import { malformedNativeEventDiagnostic } from "../diagnostics.ts";

const ReplayTextPart = Schema.Struct({
  text: Schema.String,
  type: Schema.Literal("text"),
});
const decodeReplayTextPart = Schema.decodeUnknownOption(ReplayTextPart);

const ReplayMessage = Schema.Struct({
  content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  role: Schema.Literals(["user", "assistant", "toolResult"]),
});

const replayText = (content: string | readonly unknown[]): string =>
  typeof content === "string"
    ? content
    : content
        .flatMap((part) => Option.toArray(decodeReplayTextPart(part)))
        .map((part) => part.text)
        .join("");

const replaySession = Effect.fn(function* (request: {
  readonly connection: AcpAgentConnectionShape;
  readonly messages: readonly unknown[];
  readonly report: (diagnostic: AgentEventDiagnostic) => Effect.Effect<void>;
  readonly sessionId: string;
}) {
  const { connection, messages, report, sessionId } = request;
  for (const input of messages) {
    const message = Schema.decodeUnknownOption(ReplayMessage)(input);
    if (Option.isNone(message)) {
      yield* report(
        malformedNativeEventDiagnostic(
          "pi-replay-message",
          "Pi replay message is malformed"
        )
      );
      continue;
    }
    const text = replayText(message.value.content);
    if (text.length === 0) {
      continue;
    }
    yield* connection.notify("session/update", {
      sessionId,
      update: {
        content: {
          text,
          type: "text",
        },
        sessionUpdate:
          message.value.role === "user"
            ? "user_message_chunk"
            : "agent_message_chunk",
      },
    });
  }
});

export { replaySession };
