import type { Effect, Stream } from "effect";

import { Context } from "effect";

import type {
  RuntimeJournalError,
  RuntimeValidationError,
} from "../../../contracts/internal/src/errors.ts";
import type { RuntimeJournalEntry } from "../../../contracts/internal/src/runtime/journal-entry.ts";

type AgentRuntimeEvent = RuntimeJournalEntry["event"];

export interface RuntimeEventJournalShape {
  readonly append: (
    event: AgentRuntimeEvent
  ) => Effect.Effect<
    RuntimeJournalEntry,
    RuntimeJournalError | RuntimeValidationError
  >;
  readonly entries: () => Effect.Effect<readonly RuntimeJournalEntry[]>;
  readonly stream: Stream.Stream<RuntimeJournalEntry>;
  readonly tail: Stream.Stream<RuntimeJournalEntry>;
}

export class RuntimeEventJournal extends Context.Service<
  RuntimeEventJournal,
  RuntimeEventJournalShape
>()("routekit-eval/runtime/RuntimeEventJournal") {}
