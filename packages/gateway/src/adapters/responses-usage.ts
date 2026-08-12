import {
  extensionValue,
  type OpenAiUsageExtension,
  type Usage
} from "@velum-labs/routekit-contracts/protocol-ir";

/**
 * Translate Chat Completions token accounting to the Responses vocabulary.
 * Detail objects are copied so compatible current and future counters survive;
 * notably cached_tokens and reasoning_tokens retain their native values.
 */
export function chatUsageToResponses(
  usage: Usage | null | undefined
): Record<string, unknown> | null {
  if (usage == null) return null;
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const totalTokens =
    usage.totalTokens ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  const details = extensionValue<OpenAiUsageExtension["namespace"], OpenAiUsageExtension["value"]>(
    usage.extensions,
    "openai.chat.usage-details"
  );
  const inputDetails = details?.promptTokens;
  const outputDetails = details?.completionTokens;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    inputDetails == null &&
    outputDetails == null
  ) {
    return null;
  }
  return {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
    ...(inputDetails != null ? { input_tokens_details: { ...inputDetails } } : {}),
    ...(outputDetails != null ? { output_tokens_details: { ...outputDetails } } : {})
  };
}
