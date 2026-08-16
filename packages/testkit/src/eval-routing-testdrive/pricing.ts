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
    return { model, pricingKey, ...pricing };
  }
  return undefined;
}

export function estimateTestdriveCostUsd(
  pricing: ResolvedTestdrivePricing,
  inputTokens: number,
  outputTokens: number
): number {
  return (
    (inputTokens * pricing.inputPer1mTokens + outputTokens * pricing.outputPer1mTokens) / 1_000_000
  );
}

export function selectDisjointPricedModels(
  discovered: readonly string[],
  perProfile = 2
): Readonly<{
  slates: readonly [readonly string[], readonly string[]];
  judge: string;
  classifier: string;
  author: string;
}> {
  const priced = [...new Set(discovered)]
    .filter((model) => model.startsWith("openai/") && resolveTestdrivePricing(model) !== undefined)
    .sort((left, right) => {
      const leftPrice = resolveTestdrivePricing(left);
      const rightPrice = resolveTestdrivePricing(right);
      const leftTotal =
        (leftPrice?.inputPer1mTokens ?? Number.POSITIVE_INFINITY) +
        (leftPrice?.outputPer1mTokens ?? Number.POSITIVE_INFINITY);
      const rightTotal =
        (rightPrice?.inputPer1mTokens ?? Number.POSITIVE_INFINITY) +
        (rightPrice?.outputPer1mTokens ?? Number.POSITIVE_INFINITY);
      return leftTotal === rightTotal ? left.localeCompare(right) : leftTotal - rightTotal;
    });
  const required = perProfile * 2 + 3;
  if (priced.length < required) {
    throw new Error(
      `live testdrive requires at least ${String(required)} discovered, known-priced OpenAI models`
    );
  }
  const classifier = priced.find((model) => /(?:mini|nano|small)/iu.test(model)) ?? priced[0];
  const author =
    priced.find((model) => model === "openai/gpt-4.1") ??
    priced.find((model) => model !== classifier);
  const judge =
    priced.find((model) => model === "openai/gpt-5.5") ??
    priced.find((model) => model !== classifier && model !== author);
  if (classifier === undefined || author === undefined || judge === undefined) {
    throw new Error("known-priced model selection produced no control models");
  }
  const candidates = priced.filter(
    (model) => model !== classifier && model !== author && model !== judge
  );
  const preferred = [
    "openai/gpt-5.3-codex",
    "openai/gpt-5.1-codex",
    "openai/gpt-5.1",
    "openai/gpt-5",
    "openai/o3",
    "openai/gpt-4o"
  ];
  const rankedCandidates = [
    ...preferred.filter((model) => candidates.includes(model)),
    ...candidates.filter((model) => !preferred.includes(model))
  ];
  const first = rankedCandidates.slice(0, perProfile);
  const second = rankedCandidates.slice(perProfile, perProfile * 2);
  if (first.length !== perProfile || second.length !== perProfile) {
    throw new Error("known-priced model selection produced incomplete candidate slates");
  }
  return {
    slates: [first, second],
    judge,
    classifier,
    author
  };
}
