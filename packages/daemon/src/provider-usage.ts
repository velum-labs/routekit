import type { ProviderUsageReport, ProviderUsageResponse } from "@velum-labs/routekit-control";

type Range = { from: string; to: string };

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sumNamed(value: unknown, names: readonly string[]): number | undefined {
  if (Array.isArray(value)) {
    return value.reduce<number | undefined>((sum, item) => {
      const next = sumNamed(item, names);
      return next === undefined ? sum : (sum ?? 0) + next;
    }, undefined);
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  let total: number | undefined;
  for (const [key, child] of Object.entries(record)) {
    if (names.includes(key)) {
      const parsed = number(child);
      if (parsed !== undefined) total = (total ?? 0) + parsed;
    }
    const nested = sumNamed(child, names);
    if (nested !== undefined) total = (total ?? 0) + nested;
  }
  return total;
}

async function json(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw Object.assign(new Error(`provider usage endpoint returned ${response.status}`), {
      status: response.status
    });
  }
  return response.json();
}

export async function enrichProviderUsage(
  report: ProviderUsageReport,
  range: Range,
  env: NodeJS.ProcessEnv
): Promise<ProviderUsageReport> {
  const provider = report.provider;
  const key =
    provider === "openai"
      ? env.OPENAI_ADMIN_KEY
      : provider === "anthropic"
        ? env.ANTHROPIC_ADMIN_KEY
        : undefined;
  if (key === undefined || key.length === 0) return report;
  const base = provider === "openai" ? "https://api.openai.com" : "https://api.anthropic.com";
  const usagePath =
    provider === "openai"
      ? "/v1/organization/usage/completions"
      : "/v1/organizations/usage_report/messages";
  const costPath =
    provider === "openai" ? "/v1/organization/costs" : "/v1/organizations/cost_report";
  const query = new URLSearchParams({
    start_time: String(Math.floor(Date.parse(range.from) / 1000)),
    end_time: String(Math.floor(Date.parse(range.to) / 1000))
  });
  const headers: Record<string, string> =
    provider === "openai"
      ? { authorization: `Bearer ${key}`, accept: "application/json" }
      : {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          accept: "application/json"
        };
  try {
    const [usage, cost] = await Promise.all([
      json(`${base}${usagePath}?${query}`, { headers }),
      json(`${base}${costPath}?${query}`, { headers })
    ]);
    const inputTokens = sumNamed(usage, ["input_tokens", "prompt_tokens"]);
    const outputTokens = sumNamed(usage, ["output_tokens", "completion_tokens"]);
    const totalTokens =
      inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined;
    const providerUsd = sumNamed(cost, ["amount", "cost", "cost_usd", "amount_usd"]);
    return {
      ...report,
      authority: "provider",
      status: "complete",
      observedAt: new Date().toISOString(),
      usage: {
        ...report.usage,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens, unknownTokenCount: 0 } : {})
      },
      cost: {
        ...report.cost,
        ...(providerUsd !== undefined ? { providerUsd, unknownCostCount: 0 } : {})
      }
    };
  } catch (error) {
    const status =
      typeof error === "object" && error !== null
        ? (error as { status?: unknown }).status
        : undefined;
    return {
      ...report,
      authority: "error",
      status: "partial",
      error: {
        code: status === 401 || status === 403 ? "provider_auth" : "provider_usage_unavailable",
        message: error instanceof Error ? error.message : String(error),
        retryable: status === undefined || (typeof status === "number" && status >= 500)
      }
    };
  }
}

export async function enrichProviderUsageResponse(
  response: ProviderUsageResponse,
  env: NodeJS.ProcessEnv
): Promise<ProviderUsageResponse> {
  return {
    ...response,
    reports: await Promise.all(
      response.reports.map((report) => enrichProviderUsage(report, response.range, env))
    )
  };
}
