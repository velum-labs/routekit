import { Schema } from "effect";

const MAX_AGENT_EVENT_TEXT_LENGTH = 256;
const AgentEventSafeText = Schema.String.check(
  Schema.isMaxLength(MAX_AGENT_EVENT_TEXT_LENGTH)
)
  .pipe(Schema.brand("AgentEventSafeText"))
  .annotate({ identifier: "AgentEventSafeText" });

const NonNegativeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
).annotate({
  identifier: "NonNegativeInt",
});

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  identifier: "PositiveInt",
});

export {
  AgentEventSafeText,
  MAX_AGENT_EVENT_TEXT_LENGTH,
  NonNegativeInt,
  PositiveInt,
};
