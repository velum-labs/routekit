import { Schema } from "effect";

import { DiagnosticText } from "../../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";

const NonNegativeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
).annotate({ identifier: "NonNegativeInt" });

const CompactionReason = Schema.Literals(["manual", "threshold", "overflow"]);
const CompactionTrigger = Schema.Literals(["manual", "automatic", "unknown"]);
const CompactionCause = Schema.Literals(["threshold", "overflow"]);
const commonCompaction = {
  oriCause: Schema.optionalKey(CompactionCause),
  oriTrigger: Schema.optionalKey(CompactionTrigger),
  reason: CompactionReason,
} as const;

const CompactionStart = Schema.Struct({
  ...commonCompaction,
  type: Schema.Literal("compaction_start"),
});

const CompactionEnd = Schema.Struct({
  ...commonCompaction,
  aborted: Schema.Boolean,
  durationMs: Schema.optionalKey(NonNegativeInt),
  errorMessage: Schema.optionalKey(DiagnosticText),
  result: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        estimatedTokensAfter: Schema.optionalKey(NonNegativeInt),
        tokensBefore: NonNegativeInt,
      })
    )
  ),
  type: Schema.Literal("compaction_end"),
  willRetry: Schema.optionalKey(Schema.Boolean),
});

export { CompactionEnd, CompactionStart };
