import type { Effect, Option } from "effect";

import { Context } from "effect";

import type { RuntimeJournalEntry } from "../../../contracts/internal/src/runtime/journal-entry.ts";
import type { RuntimeSessionSnapshot } from "../../../contracts/internal/src/runtime/session-snapshot-types.ts";

type SessionId = RuntimeSessionSnapshot["sessionId"];

export interface AgentSessionStoreShape {
  readonly apply: (entry: RuntimeJournalEntry) => Effect.Effect<void>;
  readonly get: (
    sessionId: SessionId
  ) => Effect.Effect<Option.Option<RuntimeSessionSnapshot>>;
  readonly list: () => Effect.Effect<readonly RuntimeSessionSnapshot[]>;
  readonly rebuild: (
    entries: readonly RuntimeJournalEntry[]
  ) => Effect.Effect<void>;
}

export class AgentSessionStore extends Context.Service<
  AgentSessionStore,
  AgentSessionStoreShape
>()("ori/runtime/AgentSessionStore") {}
