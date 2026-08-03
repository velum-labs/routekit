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

// Update this map when RouteKit qualifies newer recommended examples. Public MDX
// renders these values through components rather than embedding model IDs.
export const RECOMMENDED_MODELS = {
  anthropic: "anthropic/claude-sonnet-5",
  claudeCode: "claude-code/gpt-5.6-sol",
  codex: "codex/gpt-5.6-sol",
  google: "google/gemini-3.5-flash",
  openai: "openai/gpt-5.6-sol",
  openrouter: "openrouter/anthropic/claude-sonnet-5"
} as const;

export type RecommendedModel = keyof typeof RECOMMENDED_MODELS;

export function renderRecommendedModels(template: string): string {
  return Object.entries(RECOMMENDED_MODELS).reduce(
    (rendered, [name, model]) => rendered.replaceAll(`{{${name}}}`, model),
    template
  );
}
