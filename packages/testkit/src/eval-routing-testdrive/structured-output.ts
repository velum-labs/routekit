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
