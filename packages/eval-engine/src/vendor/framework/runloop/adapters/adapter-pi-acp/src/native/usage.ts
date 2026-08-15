import { Schema } from "effect";

const NonNegativeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
).annotate({ identifier: "PiUsageNonNegativeInt" });
const NonNegativeNumber = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0)
).annotate({ identifier: "PiUsageNonNegativeNumber" });

const PiUsage = Schema.Struct({
  cacheRead: Schema.optionalKey(NonNegativeInt),
  cacheWrite: Schema.optionalKey(NonNegativeInt),
  cost: Schema.optionalKey(
    Schema.Struct({
      total: Schema.optionalKey(NonNegativeNumber),
    })
  ),
  input: Schema.optionalKey(NonNegativeInt),
  output: Schema.optionalKey(NonNegativeInt),
  totalTokens: Schema.optionalKey(NonNegativeInt),
}).annotate({ identifier: "PiUsage" });

export { PiUsage };
