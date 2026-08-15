import type { Lambda as StructLambda } from "effect/Struct";

import { Effect, Option, Schema, SchemaTransformation, Struct } from "effect";

const decodeOrUndefined = <S extends Schema.Constraint>(
  schema: S
): Schema.ConstraintCodec<
  S["Type"] | undefined,
  unknown,
  S["DecodingServices"],
  S["EncodingServices"]
> =>
  Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.UndefinedOr(schema),
      SchemaTransformation.transformOrFail({
        decode: (value, options) =>
          Schema.decodeUnknownEffect(schema)(value, options).pipe(
            Effect.catch(() =>
              Effect.succeed(Option.none()).pipe(
                Effect.map(Option.getOrUndefined)
              )
            )
          ),
        encode: (value) => Effect.succeed(value),
      })
    )
  );

interface OptionalLenientField extends StructLambda {
  <S extends Schema.Constraint>(
    schema: S
  ): Schema.optionalKey<ReturnType<typeof decodeOrUndefined<S>>>;
  readonly "~lambda.out": this["~lambda.in"] extends Schema.Constraint
    ? Schema.optionalKey<
        ReturnType<typeof decodeOrUndefined<this["~lambda.in"]>>
      >
    : never;
}

export const optionalLenientField = Struct.lambda<OptionalLenientField>(
  (schema) => Schema.optionalKey(decodeOrUndefined(schema))
);

export { decodeOrUndefined };
