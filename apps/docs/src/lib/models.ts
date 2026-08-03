import modelCatalogData from "../../../../spec/registry/model-catalog.json";

const defaults = modelCatalogData.modelCatalog.defaultModelByAuthChoice;

export const ROUTEKIT_DEFAULT_MODELS = {
  anthropic: `anthropic/${defaults.anthropic}`,
  claudeCode: `claude-code/${defaults["claude-code"]}`,
  codex: `codex/${defaults.codex}`,
  google: `google/${defaults.google}`,
  openai: `openai/${defaults.openai}`,
  openrouter: `openrouter/${defaults.openrouter}`
} as const;

// Inline examples use the same registry-backed defaults as generated code
// examples, so a catalog change cannot leave hidden model IDs behind.
export const RECOMMENDED_MODELS = ROUTEKIT_DEFAULT_MODELS;

export type RecommendedModel = keyof typeof RECOMMENDED_MODELS;
