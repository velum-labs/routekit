import type { RequestRoutingRequirements } from "@velum-labs/routekit-eval-contracts";
import type { RoutingModelAvailability } from "@velum-labs/routekit-eval-core";

import type { Backend } from "./backend.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function hasTools(body: unknown): boolean {
  const tools = record(body)?.tools;
  return Array.isArray(tools) && tools.length > 0;
}

function contentHasImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(contentHasImage);
  const item = record(value);
  if (item === undefined) return false;
  const type = item.type;
  if (
    type === "image" ||
    type === "image_url" ||
    type === "input_image" ||
    type === "computer_screenshot"
  ) {
    return true;
  }
  const content = item.content;
  return content !== undefined && contentHasImage(content);
}

function requiresVision(body: unknown): boolean {
  const value = record(body);
  if (value === undefined) return false;
  return contentHasImage(value.messages) || contentHasImage(value.input);
}

export function deriveRoutingRequirements(
  endpoint: RequestRoutingRequirements["endpoint"],
  body: unknown
): RequestRoutingRequirements {
  const value = record(body);
  const maximumOutput =
    endpoint === "responses"
      ? positiveInteger(value?.max_output_tokens)
      : endpoint === "anthropic"
        ? positiveInteger(value?.max_tokens)
        : positiveInteger(value?.max_completion_tokens) ?? positiveInteger(value?.max_tokens);
  return {
    endpoint,
    requiresTools: hasTools(body),
    requiresVision: requiresVision(body),
    ...(maximumOutput === undefined ? {} : { maxOutputTokens: maximumOutput })
  };
}

function capabilityIsSupported(value: string | undefined): boolean {
  return value === "supported" || value === "degraded" || value === "true";
}

function capabilityLimit(
  capabilities: Readonly<Record<string, string>>,
  names: readonly string[]
): number | undefined {
  for (const name of names) {
    const raw = capabilities[name];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** Conservative projection of the live catalog into deterministic scorer input. */
export function routingModelAvailability(backend: Backend): readonly RoutingModelAvailability[] {
  return (backend.ports.models.list() ?? []).map((model) => {
    const capabilities = backend.ports.models.capabilities(model);
    const metadata = backend.ports.models.metadata(model);
    const supportedParameters = metadata?.supportedParameters ?? [];
    const inputModalities = metadata?.architecture?.inputModalities ?? [];
    const maxInputTokens = capabilityLimit(capabilities, [
      "max_input_tokens",
      "context_window",
      "max_context_window"
    ]);
    const maxOutputTokens = capabilityLimit(capabilities, [
      "max_output_tokens",
      "max_completion_tokens"
    ]);
    return {
      model,
      served: backend.ports.models.serves(model),
      endpoints: ["chat", "responses", "anthropic"],
      supportsTools:
        capabilityIsSupported(capabilities.tools) ||
        supportedParameters.includes("tools") ||
        supportedParameters.includes("tool_choice"),
      supportsVision:
        capabilityIsSupported(capabilities.vision) ||
        capabilityIsSupported(capabilities.image_input) ||
        inputModalities.some((modality) => modality.toLowerCase() === "image"),
      ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens })
    };
  });
}
