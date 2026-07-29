import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import type { ReactNode } from "react";
import { RECOMMENDED_MODELS, ROUTEKIT_DEFAULT_MODELS, renderRecommendedModels } from "@/lib/models";
import { ROUTEKIT_VERSION } from "@/lib/version";

export function RouteKitVersion() {
  return <>{ROUTEKIT_VERSION}</>;
}

type ModelValueProps = { readonly native?: boolean; readonly suffix?: string };

function modelValue(value: string, { native = false, suffix = "" }: ModelValueProps): ReactNode {
  const rendered = native ? value.slice(value.indexOf("/") + 1) : value;
  return (
    <code>
      {rendered}
      {suffix}
    </code>
  );
}

export function OpenAIModel(props: ModelValueProps) {
  return modelValue(RECOMMENDED_MODELS.openai, props);
}

export function AnthropicModel(props: ModelValueProps) {
  return modelValue(RECOMMENDED_MODELS.anthropic, props);
}

export function OpenRouterModel(props: ModelValueProps) {
  return modelValue(RECOMMENDED_MODELS.openrouter, props);
}

export function CodexModel(props: ModelValueProps) {
  return modelValue(RECOMMENDED_MODELS.codex, props);
}

export function ClaudeCodeModel(props: ModelValueProps) {
  return modelValue(RECOMMENDED_MODELS.claudeCode, props);
}

export function GoogleModel(props: ModelValueProps) {
  return modelValue(RECOMMENDED_MODELS.google, props);
}

export function RouteKitDefaultOpenAIModel(props: ModelValueProps) {
  return modelValue(ROUTEKIT_DEFAULT_MODELS.openai, props);
}

export function RouteKitModelsCode({
  code,
  lang
}: {
  readonly code: string;
  readonly lang: string;
}) {
  return <DynamicCodeBlock lang={lang} code={renderRecommendedModels(code)} />;
}
