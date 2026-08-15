import { Schema } from "effect";

import { RuntimeJournalEntryId } from "../ids.ts";
import { AgentRuntimeEventSchema } from "./agent-runtime-event.ts";

import { NonNegativeInt } from "./schema-primitives.ts";

/**
 * One appended entry in a runtime event journal. `sequence` comes from a
 * monotonic per-journal counter and is load-bearing for replay deduplication
 * (`entry.sequence > lastReplayedSequence`), so it decodes as a non-negative
 * integer: a corrupt persisted entry fails decode instead of silently
 * disappearing from the replayed tail.
 */
const RuntimeJournalEntrySchema = Schema.Struct({
  entryId: RuntimeJournalEntryId,
  event: AgentRuntimeEventSchema,
  recordedAt: Schema.String,
  sequence: NonNegativeInt,
});

type RuntimeJournalEntry = typeof RuntimeJournalEntrySchema.Type;

export const decodeRuntimeJournalEntry = Schema.decodeUnknownEffect(
  RuntimeJournalEntrySchema
);

export { RuntimeJournalEntrySchema };
export type { RuntimeJournalEntry };
