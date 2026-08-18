import { Schema } from "effect";

import { AgentParametersSchema } from "../../../../contracts/internal/src/author-schemas/parameters.ts";

const OpenRouterModelId = Schema.String.check(
  Schema.isPattern(/^[^/\s]+\/[^/\s]+$/u)
).annotate({ identifier: "OpenRouterModelId" });

const ClaudeAdapterConfig = Schema.Struct({
  cwd: Schema.NonEmptyString,
  model: OpenRouterModelId,
  // `UndefinedOr` because this config is built in-process rather than decoded
  // from JSON: an explicit `parameters: undefined` survives to the decode here,
  // where the wire command's would have been stripped by serialization.
  parameters: Schema.optionalKey(Schema.UndefinedOr(AgentParametersSchema)),
  claudeCommand: Schema.NonEmptyString,
  // Extra Claude Code plugin/skill directories (legacy `--plugin-dir`), usually the
  // framework skill roots Ori injects under `ori code`.
  pluginDirs: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  systemPrompt: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.NonEmptyString),
  openRouterSessionId: Schema.optionalKey(Schema.NonEmptyString),
}).annotate({ identifier: "ClaudeAdapterConfig" });

export { OpenRouterModelId, ClaudeAdapterConfig };
export type ClaudeAdapterConfig = typeof ClaudeAdapterConfig.Type;
