const allowedRequestKeys = new Set([
  "frequency_penalty",
  "logit_bias",
  "max_completion_tokens",
  "max_tokens",
  "presence_penalty",
  "provider",
  "reasoning",
  "reasoning_effort",
  "response_format",
  "seed",
  "stop",
  "temperature",
  "tool_choice",
  "tools",
  "top_p"
]);

export function promptFromInput(input: unknown, treatmentId?: string): {
  messages: Array<{ role: string; content: string }>;
  extra: Record<string, unknown>;
} {
  const allowedExtra = (object: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(object).filter(([key]) => allowedRequestKeys.has(key)));
  if (typeof input === "object" && input !== null) {
    const object = input as Record<string, unknown>;
    if (
      treatmentId !== undefined &&
      typeof object.requests === "object" &&
      object.requests !== null &&
      !Array.isArray(object.requests)
    ) {
      const selected = (object.requests as Record<string, unknown>)[treatmentId];
      if (selected === undefined) {
        throw new Error(`task input has no request for treatment ${JSON.stringify(treatmentId)}`);
      }
      return promptFromInput(selected);
    }
    if (
      Array.isArray(object.messages) &&
      object.messages.every(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          typeof (message as { role?: unknown }).role === "string" &&
          typeof (message as { content?: unknown }).content === "string"
      )
    ) {
      return {
        messages: object.messages as Array<{ role: string; content: string }>,
        extra: allowedExtra(object)
      };
    }
    if (typeof object.prompt === "string") {
      return {
        messages: [{ role: "user", content: object.prompt }],
        extra: allowedExtra(object)
      };
    }
  }
  return {
    messages: [{ role: "user", content: JSON.stringify(input) }],
    extra: {}
  };
}
