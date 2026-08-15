import { Effect, Option, Schema, SchemaGetter } from "effect";

const UINT16_MAX = 65_535;
const UINT32_MAX = 4_294_967_295;

type RecoveringSchema<S extends Schema.Constraint> = Schema.middlewareDecoding<
  S,
  S["DecodingServices"]
>;
type OptionalNullableSchema<
  T,
  E extends Schema.Json,
  RD,
  RE,
> = Schema.optionalKey<
  Schema.decodeTo<Schema.NullOr<Schema.Codec<T, E, RD, RE>>, typeof Schema.Json>
>;
type DefaultedSchema<S extends Schema.Constraint> =
  Schema.withDecodingDefaultTypeKey<RecoveringSchema<S>>;
const defaultOnDecodeError = <S extends Schema.Constraint>(
  schema: S,
  value: NoInfer<S["Type"]>
): RecoveringSchema<S> =>
  Schema.catchDecoding(() => Effect.succeed(Option.some(value)))(schema);
const AcpOptionalNullable = <T, E extends Schema.Json, RD, RE>(
  schema: Schema.Codec<T, E, RD, RE>,
  description?: string
): OptionalNullableSchema<T, E, RD, RE> => {
  const nullable = Schema.NullOr(schema);
  const encoded =
    description === undefined
      ? Schema.Json
      : Schema.Json.annotate({ description });
  return Schema.optionalKey(
    encoded.pipe(
      Schema.decodeTo(nullable, {
        decode: SchemaGetter.transform((value) =>
          Schema.is(Schema.toEncoded(nullable))(value) ? value : null
        ),
        encode: SchemaGetter.transform((value) => value),
      })
    )
  );
};
const AcpDefaulted = <S extends Schema.Constraint>(
  schema: S,
  value: NoInfer<S["Type"]>
): DefaultedSchema<S> =>
  Schema.withDecodingDefaultTypeKey<RecoveringSchema<S>>(Effect.succeed(value))(
    defaultOnDecodeError(schema, value)
  );
type TolerantArraySchema<
  T,
  E extends Schema.Json,
  RD,
  RE,
> = Schema.withDecodingDefaultKey<
  Schema.middlewareDecoding<
    Schema.decodeTo<
      Schema.$Array<Schema.Codec<T, E, RD, RE>>,
      Schema.$Array<typeof Schema.Json>
    >,
    RD
  >
>;
const AcpTolerantArray = <T, E extends Schema.Json, RD, RE>(
  item: Schema.Codec<T, E, RD, RE>,
  description?: string
): TolerantArraySchema<T, E, RD, RE> =>
  defaultOnDecodeError(
    Schema.Array(Schema.Json)
      .annotate(description === undefined ? {} : { description })
      .pipe(
        Schema.decodeTo(Schema.Array(item), {
          decode: SchemaGetter.transform((values) =>
            values.filter(Schema.is(Schema.toEncoded(item)))
          ),
          encode: SchemaGetter.transform((values) => values),
        })
      ),
    []
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])));
type OptionalTolerantArraySchema<T, RD, RE> = OptionalNullableSchema<
  readonly T[],
  readonly Schema.Json[],
  RD,
  RE
>;
const AcpOptionalTolerantArray = <T, E extends Schema.Json, RD, RE>(
  item: Schema.Codec<T, E, RD, RE>,
  description?: string
): OptionalTolerantArraySchema<T, RD, RE> =>
  AcpOptionalNullable(
    Schema.Array(Schema.Json).pipe(
      Schema.decodeTo(Schema.Array(item), {
        decode: SchemaGetter.transform((values) =>
          values.filter(Schema.is(Schema.toEncoded(item)))
        ),
        encode: SchemaGetter.transform((values) => values),
      })
    ),
    description
  );
const AcpMetaDescription = `The _meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)`;
const AcpMeta = Schema.Record(Schema.String, Schema.Json).annotate({
  description: AcpMetaDescription,
  identifier: "AcpMeta",
});
const AcpOptionalMeta = AcpOptionalNullable(AcpMeta, AcpMetaDescription);
// Schema.Int already rejects integers outside JavaScript's lossless safe range.
const AcpInt64 = Schema.Int.annotate({ identifier: "AcpInt64SafeNumber" });
const AcpUint16 = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(UINT16_MAX)
).annotate({ identifier: "AcpUint16" });
const AcpUint32 = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(UINT32_MAX)
).annotate({ identifier: "AcpUint32" });
const AcpUint64 = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  identifier: "AcpUint64SafeNumber",
});
const AcpRequestId = Schema.Union([
  Schema.Null,
  AcpInt64,
  Schema.String,
]).annotate({ identifier: "AcpRequestId" });

export {
  AcpDefaulted,
  AcpInt64,
  AcpOptionalMeta,
  AcpOptionalNullable,
  AcpOptionalTolerantArray,
  AcpRequestId,
  AcpTolerantArray,
  AcpUint16,
  AcpUint32,
  AcpUint64,
};
export type { OptionalNullableSchema };
