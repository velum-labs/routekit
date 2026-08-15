import type { HarnessOutputSchema } from "./agent-harness.ts";

const JSON_INDENT = 2;
const STRUCTURED_OUTPUT_HEADER = "## Structured output";

const formatSchemaName = (name: string | undefined): string =>
  name === undefined ? "" : ` named "${name}"`;

const safeJsonStringify = (value: unknown): string =>
  JSON.stringify(value, null, JSON_INDENT);

/**
 * Render a structured-output request as a system-prompt instruction (RFC
 * 0002 schedule.md). Agentic harnesses (pi, claude) cannot constrain the model
 * with a
 * native `response_format`, so the JSON Schema is injected as guidance: the run's
 * final message must be a single JSON value that validates against it. The
 * framework then parses and validates that value against the author's schema.
 */
export const formatOutputSchemaInstruction = (
  outputSchema: HarnessOutputSchema
): string => {
  const sections = [
    STRUCTURED_OUTPUT_HEADER,
    "",
    `Your final message must be a single JSON value${formatSchemaName(outputSchema.name)} that validates against this JSON Schema.`,
    "Output only that JSON value as your final message — no prose, no explanation, and no markdown code fences.",
    "",
    "JSON Schema:",
    safeJsonStringify(outputSchema.schema),
  ];

  if (outputSchema.definitions !== undefined) {
    sections.push(
      "",
      "Shared definitions ($defs):",
      safeJsonStringify(outputSchema.definitions)
    );
  }

  return sections.join("\n");
};

/**
 * Combine an existing system prompt with the structured-output instruction for an
 * optional output schema, returning `undefined` when neither is present.
 */
export const withOutputSchemaInstruction = (
  systemPrompt: string | undefined,
  outputSchema: HarnessOutputSchema | undefined
): string | undefined => {
  if (outputSchema === undefined) {
    return systemPrompt;
  }
  const instruction = formatOutputSchemaInstruction(outputSchema);
  return systemPrompt === undefined
    ? instruction
    : `${systemPrompt}\n\n${instruction}`;
};
