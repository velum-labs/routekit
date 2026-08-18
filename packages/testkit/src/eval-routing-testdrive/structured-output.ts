/**
 * Keep schema-constrained authoring focused on the bounded output contract.
 * GPT-5.6 may otherwise spend the completion budget on hidden reasoning and
 * return incomplete JSON.
 */
export const TESTDRIVE_AUTHORING_REASONING_EFFORT = "none" as const;

export const strictJsonSchemaResponseFormat = (
  name: string,
  schema: Readonly<Record<string, unknown>>
) => ({
  type: "json_schema" as const,
  json_schema: {
    name,
    schema,
    strict: true
  }
});

export const strictJsonSchemaText = (name: string, schema: Readonly<Record<string, unknown>>) => ({
  format: {
    type: "json_schema" as const,
    name,
    schema,
    strict: true
  }
});

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const responsesOutputText = (payload: unknown): string | undefined => {
  const root = record(payload);
  if (typeof root?.output_text === "string" && root.output_text.trim().length > 0) {
    return root.output_text.trim();
  }
  if (!Array.isArray(root?.output)) return undefined;
  const text = root.output
    .flatMap((item) => {
      const content = record(item)?.content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) => {
        const value = record(part);
        return value?.type === "output_text" && typeof value.text === "string" ? [value.text] : [];
      });
    })
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
};
