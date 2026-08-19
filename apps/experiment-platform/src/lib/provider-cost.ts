function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function providerCostFromPayload(payload: unknown, fallback: number): number {
  const object = record(payload);
  if (object === undefined) return fallback;
  const usage = record(object.usage);
  const costDetails = record(usage?.cost_details ?? usage?.costDetails);
  const candidates = [
    nonnegativeNumber(costDetails?.upstream_inference_cost),
    nonnegativeNumber(costDetails?.upstreamInferenceCost),
    nonnegativeNumber(usage?.market_cost),
    nonnegativeNumber(usage?.marketCost),
    nonnegativeNumber(object.market_cost),
    nonnegativeNumber(object.marketCost),
    nonnegativeNumber(object.cost_usd),
    nonnegativeNumber(usage?.cost_usd),
    nonnegativeNumber(usage?.cost),
    nonnegativeNumber(object.cost)
  ];
  return candidates.find((candidate) => candidate !== undefined && candidate > 0) ?? fallback;
}
