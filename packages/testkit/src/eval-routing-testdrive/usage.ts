export type TestdriveUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
}>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

export function usageFromPayload(payload: unknown): TestdriveUsage | undefined {
  const root = asRecord(payload);
  const usage = asRecord(root?.usage);
  if (usage === undefined) return undefined;
  const inputTokens =
    nonNegativeInteger(usage.prompt_tokens) ?? nonNegativeInteger(usage.input_tokens);
  const outputTokens =
    nonNegativeInteger(usage.completion_tokens) ?? nonNegativeInteger(usage.output_tokens);
  return inputTokens === undefined || outputTokens === undefined
    ? undefined
    : { inputTokens, outputTokens };
}

export function usageFromResponseText(text: string): TestdriveUsage | undefined {
  try {
    const direct = usageFromPayload(JSON.parse(text));
    if (direct !== undefined) return direct;
  } catch {
    // Continue with SSE decoding.
  }
  let latest: TestdriveUsage | undefined;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data.length === 0 || data === "[DONE]") continue;
    try {
      latest = usageFromPayload(JSON.parse(data)) ?? latest;
    } catch {
      // Malformed non-terminal events are ignored; absence of usage fails closed later.
    }
  }
  return latest;
}

export function reservationFromRequest(
  body: Uint8Array,
  maximumOutputTokensPerCall: number
): Readonly<{ inputTokens: number; outputTokens: number; model: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("billed egress body must be JSON");
  }
  const record = asRecord(parsed);
  const model = typeof record?.model === "string" ? record.model : undefined;
  if (model === undefined || model.trim().length === 0) {
    throw new Error("billed egress request must name an explicit model");
  }
  const requestedOutput =
    nonNegativeInteger(record?.max_completion_tokens) ??
    nonNegativeInteger(record?.max_tokens) ??
    nonNegativeInteger(record?.max_output_tokens) ??
    maximumOutputTokensPerCall;
  if (requestedOutput > maximumOutputTokensPerCall) {
    throw new Error(
      `billed egress request output cap ${String(requestedOutput)} exceeds failsafe ${String(maximumOutputTokensPerCall)}`
    );
  }
  // UTF-8 byte length is a deliberately conservative tokenizer-independent
  // reservation for ordinary text and JSON model requests.
  return {
    inputTokens: Math.max(1, body.byteLength),
    outputTokens: requestedOutput,
    model
  };
}

export function responseWithEstimatedCost(
  body: Uint8Array,
  estimatedCostUsd: number
): Uint8Array<ArrayBuffer> {
  const text = new TextDecoder().decode(body);
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (typeof payload.usage === "object" && payload.usage !== null) {
      payload.usage = {
        ...(payload.usage as Record<string, unknown>),
        cost_usd: estimatedCostUsd
      };
      return new TextEncoder().encode(JSON.stringify(payload));
    }
  } catch {
    // Continue with SSE rewriting.
  }
  const lines = text.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || !line.startsWith("data:")) continue;
    const raw = line.slice("data:".length).trim();
    if (raw === "" || raw === "[DONE]") continue;
    try {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      if (typeof payload.usage !== "object" || payload.usage === null) continue;
      payload.usage = {
        ...(payload.usage as Record<string, unknown>),
        cost_usd: estimatedCostUsd
      };
      lines[index] = `data: ${JSON.stringify(payload)}`;
      return new TextEncoder().encode(lines.join("\n"));
    } catch {
      continue;
    }
  }
  return new Uint8Array(body);
}
