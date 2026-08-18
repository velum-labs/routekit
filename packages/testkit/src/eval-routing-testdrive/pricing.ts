import {
  DEFAULT_MODEL_PRICING,
  PRICING_ALIASES,
  type RegistryModelPricing
} from "@velum-labs/routekit-registry";

export type ResolvedTestdrivePricing = Readonly<{
  model: string;
  pricingKey: string;
  inputPer1mTokens: number;
  outputPer1mTokens: number;
  priced: boolean;
}>;

const modelCandidates = (model: string): readonly string[] => {
  const normalized = model.trim();
  const segments = normalized.split("/");
  const withoutProvider = segments.length > 1 ? segments.slice(1).join("/") : normalized;
  const leaf = segments.at(-1) ?? normalized;
  return [...new Set([normalized, withoutProvider, leaf])];
};

const resolvePricingKey = (candidate: string): string | undefined => {
  let key = candidate;
  const seen = new Set<string>();
  while (!seen.has(key)) {
    seen.add(key);
    if (DEFAULT_MODEL_PRICING[key] !== undefined) return key;
    const alias = PRICING_ALIASES[key];
    if (alias === undefined) return undefined;
    key = alias;
  }
  return undefined;
};

export function resolveTestdrivePricing(model: string): ResolvedTestdrivePricing | undefined {
  for (const candidate of modelCandidates(model)) {
    const pricingKey = resolvePricingKey(candidate);
    if (pricingKey === undefined) continue;
    const pricing: RegistryModelPricing | undefined = DEFAULT_MODEL_PRICING[pricingKey];
    if (pricing === undefined) continue;
    return { model, pricingKey, ...pricing, priced: true };
  }
  return undefined;
}

export const unpricedTestdrivePricing = (model: string): ResolvedTestdrivePricing => ({
  model,
  pricingKey: "unpriced",
  inputPer1mTokens: 0,
  outputPer1mTokens: 0,
  priced: false
});

export function estimateTestdriveCostUsd(
  pricing: ResolvedTestdrivePricing,
  inputTokens: number,
  outputTokens: number
): number {
  return (
    (inputTokens * pricing.inputPer1mTokens + outputTokens * pricing.outputPer1mTokens) / 1_000_000
  );
}

export function selectTestdriveModels(discovered: readonly string[]): Readonly<{
  candidates: readonly string[];
  judge: string;
  classifier: string;
  author: string;
}> {
  const available = new Set(discovered);
  const candidates = ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra", "openai/gpt-5.6-sol"] as const;
  const missing = candidates.filter((model) => !available.has(model));
  if (missing.length > 0) {
    throw new Error(`live testdrive catalog is missing ${missing.join(", ")}`);
  }
  return {
    candidates,
    judge: "openai/gpt-5.6-terra",
    classifier: "openai/gpt-5.6-luna",
    author: "openai/gpt-5.6-terra"
  };
}

export function selectClassifierQualificationModel(discovered: readonly string[]): string {
  const classifier = "openai/gpt-5.6-luna";
  if (!new Set(discovered).has(classifier)) {
    throw new Error(`live classifier qualification catalog is missing ${classifier}`);
  }
  return classifier;
}
