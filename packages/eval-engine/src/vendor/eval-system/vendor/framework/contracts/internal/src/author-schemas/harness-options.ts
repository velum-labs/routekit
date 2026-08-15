import type { Effect, Ref } from "effect";

import { Schema } from "effect";

import type { HarnessInvokeOptions as AuthorHarnessInvokeOptions } from "../../../author/src/index.ts";
import type { AssertAssignable } from "../type-boundary.ts";
/**
 * Effect Schema mirror of author-facing shapes from `@routekit-eval-contracts/author`.
 * Authors import the plain TypeScript types; the engine decodes against these
 * schemas. `AssertAssignable` keeps each schema Encoded type assignable to the
 * author contract so the two layers cannot drift.
 */
import type { ValueOf } from "../../../../utils/core/src/types.ts";

import { HarnessType as AuthorHarnessType } from "../../../author/src/index.ts";
import { SessionId } from "../ids.ts";

import { AgentParametersSchema } from "./parameters.ts";

const harnessType = AuthorHarnessType;

type HarnessType = ValueOf<typeof harnessType>;

/**
 * A structured-output request carried on an invoke: a JSON Schema (Draft
 * 2020-12) the run should return, plus its `$defs` pool and an optional name
 * (RFC 0002 schedule.md). The JSON Schema bodies are opaque (`Unknown`) so they survive the
 * wire round-trip without a recursive JSON-Schema codec.
 */
const HarnessOutputSchemaSchema = Schema.Struct({
  definitions: Schema.optionalKey(Schema.Unknown),
  name: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  schema: Schema.Unknown,
});

const HarnessInvokeOptionsSchema = Schema.Struct({
  contextWindow: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  cwd: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  disableBundledSkills: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  env: Schema.optionalKey(
    Schema.UndefinedOr(
      Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String))
    )
  ),
  extraSkillDirs: Schema.optionalKey(
    Schema.UndefinedOr(Schema.Array(Schema.String))
  ),
  interactionSurface: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  model: Schema.optionalKey(Schema.UndefinedOr(Schema.NullOr(Schema.String))),
  parameters: Schema.optionalKey(Schema.UndefinedOr(AgentParametersSchema)),
  outputSchema: Schema.optionalKey(
    Schema.UndefinedOr(HarnessOutputSchemaSchema)
  ),
  prompt: Schema.String,
  resumeToken: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  sessionId: Schema.optionalKey(Schema.UndefinedOr(SessionId)),
  systemPrompt: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  temperature: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  type: Schema.Literal(harnessType.InvokeOptions),
  userId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

type RuntimeHarnessInvokeOptions = typeof HarnessInvokeOptionsSchema.Type & {
  readonly cancelState?: Ref.Ref<boolean> | undefined;
  readonly cancelSignal?: Effect.Effect<unknown> | undefined;
};
type HarnessInvokeOptions = AuthorHarnessInvokeOptions;

type _HarnessInvokeOptionsSchemaEncodesAuthor = AssertAssignable<
  typeof HarnessInvokeOptionsSchema.Encoded,
  HarnessInvokeOptions
>;

export const buildHarnessInvokeOptions = (
  prompt: string,
  options: Omit<RuntimeHarnessInvokeOptions, "prompt" | "type"> = {}
): RuntimeHarnessInvokeOptions => {
  const output = {
    contextWindow: options.contextWindow,
    cwd: options.cwd,
    disableBundledSkills: options.disableBundledSkills,
    env: options.env,
    extraSkillDirs: options.extraSkillDirs,
    interactionSurface: options.interactionSurface,
    model: options.model,
    parameters: options.parameters,
    outputSchema: options.outputSchema,
    prompt,
    resumeToken: options.resumeToken,
    sessionId: options.sessionId,
    systemPrompt: options.systemPrompt,
    temperature: options.temperature,
    type: harnessType.InvokeOptions,
    userId: options.userId,
  } satisfies RuntimeHarnessInvokeOptions;

  return output;
};

export const decodeHarnessInvokeOptions = Schema.decodeUnknownEffect(
  HarnessInvokeOptionsSchema
);

export { harnessType, HarnessOutputSchemaSchema, HarnessInvokeOptionsSchema };
export type { HarnessType, RuntimeHarnessInvokeOptions, HarnessInvokeOptions };
