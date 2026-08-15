import { Schema } from "effect";

const CodexAdapterConfig = Schema.Struct({
  cwd: Schema.NonEmptyString,
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  model: Schema.NonEmptyString,
  systemPrompt: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CodexAdapterConfig" });

export { CodexAdapterConfig };
export type CodexAdapterConfig = typeof CodexAdapterConfig.Type;
