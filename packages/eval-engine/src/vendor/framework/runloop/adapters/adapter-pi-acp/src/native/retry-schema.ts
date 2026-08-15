import { Schema } from "effect";

import { DiagnosticText } from "../../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";

const PiCommandId = Schema.NonEmptyString;

const ForkCommand = Schema.Struct({
  entryId: PiCommandId,
  id: Schema.optionalKey(PiCommandId),
  type: Schema.Literal("fork"),
});

const GetForkMessagesCommand = Schema.Struct({
  id: Schema.optionalKey(PiCommandId),
  type: Schema.Literal("get_fork_messages"),
});

const ForkResult = Schema.Struct({
  cancelled: Schema.Boolean,
  text: Schema.optionalKey(Schema.String),
});

const GetForkMessagesResult = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      entryId: PiCommandId,
      text: Schema.String,
    })
  ),
});

const RetryStart = Schema.Struct({
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  delayMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  errorMessage: Schema.optionalKey(DiagnosticText),
  maxAttempts: Schema.Int.check(Schema.isGreaterThan(0)),
  type: Schema.Literal("auto_retry_start"),
});

const RetryEnd = Schema.Struct({
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  finalError: Schema.optionalKey(DiagnosticText),
  success: Schema.Boolean,
  type: Schema.Literal("auto_retry_end"),
});

// `willRetry` is Pi's own verdict on the attempt that just ended: true means the
// backoff above will run the turn again, so the turn is NOT over. It lives here
// with the retry events because it is the field that arbitrates between them.
const AgentEnd = Schema.Struct({
  type: Schema.Literal("agent_end"),
  willRetry: Schema.optionalKey(Schema.Boolean),
});

export {
  AgentEnd,
  ForkCommand,
  ForkResult,
  GetForkMessagesCommand,
  GetForkMessagesResult,
  RetryEnd,
  RetryStart,
};
