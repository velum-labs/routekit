import { Effect, Schema } from "effect";

import {
  AcpDefaulted,
  AcpInt64,
  AcpOptionalNullable,
  AcpOptionalTolerantArray,
  AcpRequestId,
  AcpUint32,
  AcpUint64,
} from "../primitives.ts";

import type { WithMeta } from "./common.ts";

import { withMeta } from "./common.ts";

type OpaqueObject<Fields extends Schema.Struct.Fields> = Schema.StructWithRest<
  Schema.Struct<Fields>,
  readonly [Schema.$Record<Schema.String, typeof Schema.Json>]
>;

const excluding = (
  values: readonly string[],
  identifier: string
): Schema.String =>
  Schema.String.check(
    Schema.makeFilter((value) =>
      values.includes(value)
        ? {
            issue: `expected a string other than ${values.join(", ")}`,
            path: [],
          }
        : undefined
    )
  ).annotate({ identifier });
const opaqueObject = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): OpaqueObject<Fields> =>
  Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Json),
  ]);

const SessionId = Schema.String;
const ToolCallId = Schema.String;
const ElicitationId = Schema.String;

const ElicitationFormCapabilities = withMeta({}).annotate({
  identifier: "ElicitationFormCapabilities",
});
const ElicitationUrlCapabilities = withMeta({}).annotate({
  identifier: "ElicitationUrlCapabilities",
});
const ElicitationCapabilities = withMeta({
  form: AcpOptionalNullable(ElicitationFormCapabilities),
  url: AcpOptionalNullable(ElicitationUrlCapabilities),
}).annotate({ identifier: "ElicitationCapabilities" });
export const ClientElicitationCapabilityFields = {
  elicitation: AcpOptionalNullable(ElicitationCapabilities),
} as const;

const EnumOption = withMeta({
  const: Schema.String,
  description: AcpOptionalNullable(Schema.String),
  title: Schema.String,
});
const StringMultiSelectItems = withMeta({
  enum: Schema.Array(Schema.String),
  type: Schema.Literal("string"),
});
const TitledMultiSelectItems = withMeta({
  anyOf: Schema.Array(EnumOption),
});
const MultiSelectItems = Schema.Union([
  StringMultiSelectItems,
  TitledMultiSelectItems,
]);
const CommonPropertyFields = {
  description: AcpOptionalNullable(Schema.String),
  title: AcpOptionalNullable(Schema.String),
} as const;
const StringPropertySchema = withMeta({
  ...CommonPropertyFields,
  default: AcpOptionalNullable(Schema.String),
  enum: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  format: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["email", "uri", "date", "date-time"]))
  ),
  maxLength: Schema.optionalKey(Schema.NullOr(AcpUint32)),
  minLength: Schema.optionalKey(Schema.NullOr(AcpUint32)),
  oneOf: Schema.optionalKey(Schema.NullOr(Schema.Array(EnumOption))),
  pattern: Schema.optionalKey(Schema.NullOr(Schema.String)),
  type: Schema.Literal("string"),
});
const NumberPropertySchema = withMeta({
  ...CommonPropertyFields,
  default: AcpOptionalNullable(Schema.Finite),
  maximum: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  minimum: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  type: Schema.Literal("number"),
});
const IntegerPropertySchema = withMeta({
  ...CommonPropertyFields,
  default: AcpOptionalNullable(AcpInt64),
  maximum: Schema.optionalKey(Schema.NullOr(AcpInt64)),
  minimum: Schema.optionalKey(Schema.NullOr(AcpInt64)),
  type: Schema.Literal("integer"),
});
const BooleanPropertySchema = withMeta({
  ...CommonPropertyFields,
  default: AcpOptionalNullable(Schema.Boolean),
  type: Schema.Literal("boolean"),
});
const MultiSelectPropertySchema = withMeta({
  ...CommonPropertyFields,
  default: AcpOptionalTolerantArray(Schema.String),
  items: MultiSelectItems,
  maxItems: Schema.optionalKey(Schema.NullOr(AcpUint64)),
  minItems: Schema.optionalKey(Schema.NullOr(AcpUint64)),
  type: Schema.Literal("array"),
});
const UnknownPropertySchema = opaqueObject({
  type: excluding(
    ["string", "number", "integer", "boolean", "array"],
    "UnknownElicitationPropertyType"
  ),
});

const ElicitationPropertySchema = Schema.Union([
  StringPropertySchema,
  NumberPropertySchema,
  IntegerPropertySchema,
  BooleanPropertySchema,
  MultiSelectPropertySchema,
  UnknownPropertySchema,
]).annotate({ identifier: "ElicitationPropertySchema" });
const ElicitationSchema = withMeta({
  description: AcpOptionalNullable(Schema.String),
  properties: Schema.Record(Schema.String, ElicitationPropertySchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({}))
  ),
  required: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  title: AcpOptionalNullable(Schema.String),
  type: AcpDefaulted(Schema.Literal("object"), "object"),
}).annotate({ identifier: "ElicitationSchema" });

const ElicitationSessionScope = {
  sessionId: SessionId,
  toolCallId: AcpOptionalNullable(ToolCallId),
} as const;
const ElicitationRequestScope = {
  requestId: AcpRequestId,
} as const;
const formParams = <Scope extends Schema.Struct.Fields>(
  scope: Scope
): WithMeta<
  Scope & {
    message: typeof Schema.String;
    mode: Schema.Literal<"form">;
    requestedSchema: typeof ElicitationSchema;
  }
> =>
  withMeta({
    ...scope,
    message: Schema.String,
    mode: Schema.Literal("form"),
    requestedSchema: ElicitationSchema,
  });
const urlParams = <Scope extends Schema.Struct.Fields>(
  scope: Scope
): WithMeta<
  Scope & {
    elicitationId: typeof ElicitationId;
    message: typeof Schema.String;
    mode: Schema.Literal<"url">;
    url: typeof Schema.String;
  }
> =>
  withMeta({
    ...scope,
    elicitationId: ElicitationId,
    message: Schema.String,
    mode: Schema.Literal("url"),
    url: Schema.String,
  });

export const CreateElicitationFormParams = Schema.Union([
  formParams(ElicitationSessionScope),
  formParams(ElicitationRequestScope),
]).annotate({ identifier: "CreateElicitationFormParams" });
const CreateElicitationUrlParams = Schema.Union([
  urlParams(ElicitationSessionScope),
  urlParams(ElicitationRequestScope),
]).annotate({ identifier: "CreateElicitationUrlParams" });
const unknownParams = <Scope extends Schema.Struct.Fields>(
  scope: Scope
): OpaqueObject<
  Scope & {
    message: typeof Schema.String;
    mode: Schema.String;
  }
> =>
  opaqueObject({
    ...scope,
    message: Schema.String,
    mode: excluding(["form", "url"], "UnknownElicitationMode"),
  });
const CreateUnknownElicitationParams = Schema.Union([
  unknownParams(ElicitationSessionScope),
  unknownParams(ElicitationRequestScope),
]).annotate({ identifier: "CreateUnknownElicitationParams" });
export const CreateElicitationParams = Schema.Union([
  CreateElicitationFormParams,
  CreateElicitationUrlParams,
  CreateUnknownElicitationParams,
]).annotate({ identifier: "CreateElicitationParams" });

const ElicitationContentValue = Schema.Union([
  Schema.String,
  AcpInt64,
  Schema.Finite,
  Schema.Boolean,
  Schema.Array(Schema.String),
]).annotate({ identifier: "ElicitationContentValue" });
const ElicitationAcceptResult = withMeta({
  action: Schema.Literal("accept"),
  content: Schema.optionalKey(
    Schema.NullOr(Schema.Record(Schema.String, ElicitationContentValue))
  ),
});
const ElicitationDeclineResult = withMeta({
  action: Schema.Literal("decline"),
});
const ElicitationCancelResult = withMeta({
  action: Schema.Literal("cancel"),
});
const UnknownElicitationResult = opaqueObject({
  action: excluding(
    ["accept", "decline", "cancel"],
    "UnknownElicitationAction"
  ),
});

export const CreateElicitationResult = Schema.Union([
  ElicitationAcceptResult,
  ElicitationDeclineResult,
  ElicitationCancelResult,
  UnknownElicitationResult,
]).annotate({ identifier: "CreateElicitationResult" });
export const CompleteElicitationParams = withMeta({
  elicitationId: ElicitationId,
}).annotate({ identifier: "CompleteElicitationParams" });
