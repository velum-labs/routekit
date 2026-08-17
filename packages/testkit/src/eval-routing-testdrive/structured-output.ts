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
