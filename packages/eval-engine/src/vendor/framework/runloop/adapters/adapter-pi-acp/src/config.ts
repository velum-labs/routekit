import { Schema } from "effect";

const PiAdapterConfig = Schema.Struct({
  // The fully-formed argument vector `piCommand` is spawned with, including the
  // runtime wrapper and `--model openrouter/<model>` flag. The caller owns this
  // shape end to end (the selected-adapter contribution builds it via
  // `resolvePiLaunchPlan`); this adapter never synthesizes a default.
  args: Schema.Array(Schema.String),
  cwd: Schema.NonEmptyString,
  env: Schema.Record(Schema.String, Schema.String),
  piCommand: Schema.NonEmptyString,
}).annotate({ identifier: "PiAdapterConfig" });

export { PiAdapterConfig };
export type PiAdapterConfig = typeof PiAdapterConfig.Type;
