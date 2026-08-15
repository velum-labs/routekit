import { Schema } from "effect";

import type { AgentParameters } from "../../../author/src/parameters.ts";
import type { AssertAssignable } from "../type-boundary.ts";

import { ReasoningEffortSchema } from "./reasoning-effort.ts";

const ReasoningParametersSchema = Schema.Struct({
  effort: Schema.optionalKey(Schema.UndefinedOr(ReasoningEffortSchema)),
});

const AgentParametersSchema = Schema.Struct({
  reasoning: Schema.optionalKey(Schema.UndefinedOr(ReasoningParametersSchema)),
});

type _AgentParametersSchemaEncodesAuthor = AssertAssignable<
  typeof AgentParametersSchema.Encoded,
  AgentParameters
>;

export { AgentParametersSchema, ReasoningParametersSchema };
