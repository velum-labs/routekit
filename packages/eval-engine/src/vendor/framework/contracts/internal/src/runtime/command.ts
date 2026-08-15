import { Schema } from "effect";

import type {
  InvokeRuntimeCommand as InvokeRuntimeCommandType,
  RuntimeCommand as RuntimeCommandType,
} from "./command-types.ts";
import type { RuntimeCommandTag as RuntimeCommandTagType } from "./protocol-tags.ts";
import type { AssertAssignable } from "../type-boundary.ts";

import { HarnessOutputSchemaSchema } from "../author-schemas/harness-options.ts";
import { AgentParametersSchema } from "../author-schemas/parameters.ts";
import {
  HarnessName,
  RuntimeCommandId,
  SessionId,
} from "../ids.ts";
import { RuntimeCommandTag as RuntimeCommandTagValue } from "./protocol-tags.ts";

const RuntimeCommandTag = RuntimeCommandTagValue;
type RuntimeCommandTag = RuntimeCommandTagType;

/** The fork-thread directive (Fork Thread, RFC 0003). */
const ForkThreadDirectiveSchema = Schema.Struct({
  parentSessionId: SessionId,
});

const InvokeRuntimeCommandSchema = Schema.Struct({
  commandId: RuntimeCommandId,
  cwd: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String))
  ),
  featuresRoot: Schema.optionalKey(Schema.String),
  forceRollover: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  harnessName: Schema.optionalKey(HarnessName),
  interactionSurface: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  outputSchema: Schema.optionalKey(HarnessOutputSchemaSchema),
  parameters: Schema.optionalKey(AgentParametersSchema),
  prompt: Schema.String,
  sessionId: Schema.optionalKey(SessionId),
  telemetrySurface: Schema.optionalKey(Schema.String),
  fork: Schema.optionalKey(ForkThreadDirectiveSchema),
  systemPrompt: Schema.optionalKey(Schema.String),
  temperature: Schema.optionalKey(Schema.Number),
  type: Schema.Literal(RuntimeCommandTag.InvokeAgent),
  userId: Schema.optionalKey(Schema.String),
});

const RuntimeCommandSchema = Schema.Union([InvokeRuntimeCommandSchema]);

type InvokeRuntimeCommand = InvokeRuntimeCommandType;
type RuntimeCommand = RuntimeCommandType;

type _InvokeRuntimeCommandSchemaEncodesContract = AssertAssignable<
  typeof InvokeRuntimeCommandSchema.Type,
  InvokeRuntimeCommand
>;
type _RuntimeCommandSchemaEncodesContract = AssertAssignable<
  typeof RuntimeCommandSchema.Type,
  RuntimeCommand
>;

export const decodeRuntimeCommand =
  Schema.decodeUnknownEffect(RuntimeCommandSchema);

export {
  RuntimeCommandTag,
  InvokeRuntimeCommandSchema,
  RuntimeCommandSchema,
  ForkThreadDirectiveSchema,
};
export type { InvokeRuntimeCommand, RuntimeCommand };
