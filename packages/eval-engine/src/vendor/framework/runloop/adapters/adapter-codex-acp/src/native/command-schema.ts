import { Schema } from "effect";

import type { CodexRequestCommand } from "./schema.ts";

const InitializeResponse = Schema.Struct({
  codexHome: Schema.String,
  platformFamily: Schema.String,
  platformOs: Schema.String,
  userAgent: Schema.String,
});
// A loose projection of Codex's `ThreadItem` tagged union: only the shape
// `loadSession` replay needs (user/agent text) is modeled; every other item
// type (tool calls, reasoning, etc.) decodes with `text`/`content` absent and
// is skipped by the replay, matching live-turn projection's own
// known/unknown split.
const ThreadItem = Schema.Struct({
  content: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        text: Schema.optionalKey(Schema.String),
        type: Schema.String,
      })
    )
  ),
  text: Schema.optionalKey(Schema.String),
  type: Schema.String,
});
const Turn = Schema.Struct({
  id: Schema.String,
  items: Schema.Array(ThreadItem),
});
// `turns` is populated by `thread/resume` (the reconstructed history) but
// absent from `thread/start`, which always begins a turn-less thread.
const ThreadResponse = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.NonEmptyString,
    turns: Schema.optionalKey(Schema.Array(Turn)),
  }),
});
const TurnResponse = Schema.Struct({
  turn: Schema.Struct({ id: Schema.NonEmptyString }),
});

// Ties each outgoing command's method to the schema that decodes its result,
// so callers get a result type derived from the command instead of asserting it.
const CodexCommandResultSchemas = {
  initialize: InitializeResponse,
  "thread/start": ThreadResponse,
  "thread/resume": ThreadResponse,
  "turn/interrupt": Schema.Unknown,
  "turn/start": TurnResponse,
} satisfies Record<CodexRequestCommand["method"], Schema.Top>;

type CodexRequestMethod = CodexRequestCommand["method"];
type CodexCommandResult<Method extends CodexRequestMethod> =
  (typeof CodexCommandResultSchemas)[Method]["Type"];
type ThreadItem = typeof ThreadItem.Type;

export { CodexCommandResultSchemas };
export type { CodexCommandResult, CodexRequestMethod, ThreadItem };
