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

type PartialTestdriveUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
}>;

const usagePart = (payload: unknown): PartialTestdriveUsage => {
  const root = asRecord(payload);
  const candidates = [
    asRecord(root?.usage),
    asRecord(asRecord(root?.response)?.usage),
    asRecord(asRecord(root?.message)?.usage),
    asRecord(asRecord(asRecord(root?.message_start)?.message)?.usage),
    asRecord(asRecord(root?.message_delta)?.usage)
  ].filter((value): value is Record<string, unknown> => value !== undefined);
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for (const usage of candidates) {
    inputTokens =
      nonNegativeInteger(usage.prompt_tokens) ??
      nonNegativeInteger(usage.input_tokens) ??
      inputTokens;
    outputTokens =
      nonNegativeInteger(usage.completion_tokens) ??
      nonNegativeInteger(usage.output_tokens) ??
      outputTokens;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens })
  };
};

export function usageFromPayload(payload: unknown): TestdriveUsage | undefined {
  const part = usagePart(payload);
  const inputTokens = part.inputTokens;
  const outputTokens = part.outputTokens;
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
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data.length === 0 || data === "[DONE]") continue;
    try {
      const part = usagePart(JSON.parse(data));
      inputTokens = part.inputTokens ?? inputTokens;
      outputTokens = part.outputTokens ?? outputTokens;
    } catch {
      // Malformed non-terminal events are ignored; absence of usage fails closed later.
    }
  }
  return inputTokens === undefined || outputTokens === undefined
    ? undefined
    : { inputTokens, outputTokens };
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

export function requestWithUsage(body: Uint8Array): Uint8Array<ArrayBuffer> {
  try {
    const payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    if (payload.stream !== true) return new Uint8Array(body);
    payload.stream_options = {
      ...(typeof payload.stream_options === "object" && payload.stream_options !== null
        ? (payload.stream_options as Record<string, unknown>)
        : {}),
      include_usage: true
    };
    return new TextEncoder().encode(JSON.stringify(payload));
  } catch {
    return new Uint8Array(body);
  }
}

export function responseWithEstimatedCost(
  body: Uint8Array,
  estimatedCostUsd: number,
  usage?: TestdriveUsage
): Uint8Array<ArrayBuffer> {
  const text = new TextDecoder().decode(body);
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (usage !== undefined) {
      payload.usage = {
        ...(typeof payload.usage === "object" && payload.usage !== null
          ? (payload.usage as Record<string, unknown>)
          : {}),
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        cost_usd: estimatedCostUsd
      };
      return new TextEncoder().encode(JSON.stringify(payload));
    }
  } catch {
    // Continue with SSE rewriting.
  }
  const lines = text.split(/\r?\n/u);
  if (usage !== undefined) {
    const doneIndex = lines.findIndex((line) => line.trim() === "data: [DONE]");
    const usageEvent = `data: ${JSON.stringify({
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        cost_usd: estimatedCostUsd
      }
    })}`;
    lines.splice(doneIndex < 0 ? lines.length : doneIndex, 0, usageEvent, "");
    return new TextEncoder().encode(lines.join("\n"));
  }
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
