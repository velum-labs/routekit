import { Effect, Schema } from "effect";

import type { ElicitationFieldType } from "../../../contracts/author/src/agent-event.ts";
import type { AcpAgentKnownRequest } from "../../../contracts/internal/src/acp/protocol/profile.ts";
import type { ElicitationContentValidator } from "../../interaction/src/model.ts";

// The decoded `requestedSchema` of a form-mode `elicitation/create` request and
// its property variants, projected straight off the wire request type so the
// bridge never re-declares the ACP schema shape.
type ElicitationParams = Extract<
  AcpAgentKnownRequest,
  { readonly method: "elicitation/create" }
>["params"];
export type FormParams = Extract<ElicitationParams, { readonly mode: "form" }>;
type RequestedSchema = FormParams["requestedSchema"];
type PropertySchema = RequestedSchema["properties"][string];
type KnownFieldType = "array" | "boolean" | "integer" | "number" | "string";

// A schema value with no decoding/encoding service requirements — the common
// supertype of every leaf schema this module builds (`String`, `Literals`,
// `Int`, `Finite`, `Boolean`, `Array`). Typing the collected fields as this
// (rather than `Schema.Top`, whose services widen to `unknown`) keeps the
// derived struct decodable with an empty environment.
type ValueSchema = Schema.Codec<unknown>;

const REJECTION_DETAIL =
  "submitted form content did not satisfy the requested schema";

// The wire property union carries an opaque catch-all whose `type` is a bare
// `string`, so it also matches every known literal in a plain `switch`. This
// guard narrows to exactly the requested literal variant, excluding that
// catch-all (which the caller leaves unvalidated).
const isFieldType = <T extends KnownFieldType>(
  property: PropertySchema,
  type: T
): property is Extract<PropertySchema, { readonly type: T }> =>
  property.type === type;

/** Map a wire property `type` to the journal-safe field summary vocabulary. */
export const fieldTypeOf = (property: PropertySchema): ElicitationFieldType => {
  switch (property.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "array": {
      return property.type;
    }
    default: {
      return "unknown";
    }
  }
};

// The min/max length filter applies to both strings and arrays (it checks
// `.length`), so one helper covers a string's minLength/maxLength and a
// multi-select array's minItems/maxItems.
const withLengthBounds = (
  base: Schema.String | Schema.$Array<ValueSchema>,
  min: number | null | undefined,
  max: number | null | undefined
): ValueSchema => {
  if (typeof min === "number" && typeof max === "number") {
    return base.check(Schema.isMinLength(min), Schema.isMaxLength(max));
  }
  if (typeof min === "number") {
    return base.check(Schema.isMinLength(min));
  }
  if (typeof max === "number") {
    return base.check(Schema.isMaxLength(max));
  }
  return base;
};

const boundedString = (
  property: Extract<PropertySchema, { type: "string" }>
): ValueSchema => {
  const values = property.enum ?? undefined;
  if (values && values.length > 0) {
    return Schema.Literals(values);
  }
  const oneOf = property.oneOf ?? undefined;
  if (oneOf && oneOf.length > 0) {
    return Schema.Literals(oneOf.map((option) => option.const));
  }
  return withLengthBounds(
    Schema.String,
    property.minLength,
    property.maxLength
  );
};

const boundedNumber = (
  property: Extract<PropertySchema, { type: "integer" | "number" }>
): ValueSchema => {
  const base = property.type === "integer" ? Schema.Int : Schema.Finite;
  const { maximum: max, minimum: min } = property;
  if (typeof min === "number" && typeof max === "number") {
    return base.check(
      Schema.isGreaterThanOrEqualTo(min),
      Schema.isLessThanOrEqualTo(max)
    );
  }
  if (typeof min === "number") {
    return base.check(Schema.isGreaterThanOrEqualTo(min));
  }
  if (typeof max === "number") {
    return base.check(Schema.isLessThanOrEqualTo(max));
  }
  return base;
};

const multiSelectValues = (
  items: Extract<PropertySchema, { type: "array" }>["items"]
): readonly string[] =>
  "anyOf" in items ? items.anyOf.map((option) => option.const) : items.enum;

export const fieldOptionsOf = (
  property: PropertySchema
): readonly string[] | undefined => {
  if (isFieldType(property, "string")) {
    const values =
      property.enum ??
      property.oneOf?.map((option) => option.const) ??
      undefined;
    return values !== undefined && values.length > 0 ? values : undefined;
  }
  if (isFieldType(property, "array")) {
    const values = multiSelectValues(property.items);
    return values.length > 0 ? values : undefined;
  }
  return undefined;
};

const boundedArray = (
  property: Extract<PropertySchema, { type: "array" }>
): ValueSchema => {
  const values = multiSelectValues(property.items);
  const element: ValueSchema =
    values.length > 0 ? Schema.Literals(values) : Schema.String;
  return withLengthBounds(
    Schema.Array(element),
    property.minItems,
    property.maxItems
  );
};

// A value schema for one property. Types outside the restricted ACP form
// vocabulary remain opaque, so their declared key is accepted whatever it
// carries.
const propertyValueSchema = (property: PropertySchema): ValueSchema => {
  if (isFieldType(property, "string")) {
    return boundedString(property);
  }
  if (isFieldType(property, "number") || isFieldType(property, "integer")) {
    return boundedNumber(property);
  }
  if (isFieldType(property, "boolean")) {
    return Schema.Boolean;
  }
  if (isFieldType(property, "array")) {
    return boundedArray(property);
  }
  return Schema.Unknown;
};

/**
 * Build the {@link ElicitationContentValidator} for a form request from its
 * decoded `requestedSchema`. It decodes submitted content against a struct
 * derived from the declared properties — enforcing declared types, bounds,
 * enums, required fields, and rejecting unknown extra keys — before an accept
 * settles. A rejection carries only a bounded, value-free detail so nothing
 * from the form leaks into the typed error.
 */
export const buildAcceptValidator = (
  requestedSchema: RequestedSchema
): ElicitationContentValidator => {
  const required = new Set(requestedSchema.required);
  const fields: Record<string, ValueSchema> = {};
  for (const [name, property] of Object.entries(requestedSchema.properties)) {
    const value = propertyValueSchema(property);
    // A type outside the ACP vocabulary has no editor to render, so no surface
    // can collect one and demanding it would leave cancelling as the only way
    // out of the dialog. Such a field is accepted if present, never required.
    const isDemanded =
      required.has(name) && fieldTypeOf(property) !== "unknown";
    fields[name] = isDemanded ? value : Schema.optionalKey(value);
  }
  const struct = Schema.Struct(fields);
  const decode = Schema.decodeUnknownEffect(struct, {
    onExcessProperty: "error",
  });
  return (content) =>
    decode(content).pipe(
      Effect.as(content),
      Effect.mapError(() => ({ detail: REJECTION_DETAIL }))
    );
};
