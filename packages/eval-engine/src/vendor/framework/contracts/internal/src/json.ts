import type { Effect, SchemaAST } from "effect";

import { Schema, SchemaGetter } from "effect";

export const decodeJsonString = <S extends Schema.Top>(
  schema: S
): ((
  input: unknown,
  options?: SchemaAST.ParseOptions
) => Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]>) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

/**
 * Intentional alias of `decodeJsonString` for NDJSON line call sites (e.g.
 * `daemon-client.ts`) where "line" communicates intent more clearly than
 * "string" — both parse a JSON-encoded string through Effect Schema.
 */
export const decodeJsonLine = <S extends Schema.Top>(
  schema: S
): ((
  input: unknown,
  options?: SchemaAST.ParseOptions
) => Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]>) =>
  decodeJsonString(schema);

export const decodeJsonLineSync = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
): ((input: unknown, options?: SchemaAST.ParseOptions) => S["Type"]) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema));

// `Schema.fromJsonString` always encodes compact JSON — the v4 beta dropped the
// `space` option the old `Schema.parseJson` accepted. For call sites that write
// human-readable files (config, credentials, descriptors) we rebuild the same
// parse/stringify transformation but hand `JSON.stringify`'s indent through the
// stringify getter, so pretty output round-trips through decode unchanged. With
// no `space` this is byte-identical to `Schema.fromJsonString(schema)`.
const jsonStringSchema = <S extends Schema.Top>(
  schema: S,
  space?: number
): Schema.decodeTo<S, typeof Schema.String> =>
  Schema.String.pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.parseJson<string>(),
      encode: SchemaGetter.stringifyJson({ space }),
    })
  );

// Encode a value to a JSON string through Effect Schema — the boundary-safe
// replacement for `JSON.stringify` (validates the value and round-trips non-JSON
// types like Date). Pass `space` for indented output; most call sites write files
// inside an Effect, so this Effect-returning form is the common one.
export const encodeJsonString = <S extends Schema.Top>(
  schema: S,
  space?: number
): ((
  input: S["Type"],
  options?: SchemaAST.ParseOptions
) => Effect.Effect<string, Schema.SchemaError, S["EncodingServices"]>) =>
  Schema.encodeEffect(jsonStringSchema(schema, space));

// Synchronous compact encode, mirroring `decodeJsonLineSync`. Throws a
// `SchemaError` on an invalid value. Compact only: the indented `space` path
// lives on the Effect-returning `encodeJsonString`, since the `encodeSync`
// constraint does not admit the rebuilt space-carrying transformation.
export const encodeJsonStringSync = <
  S extends Schema.ConstraintEncoder<unknown>,
>(
  schema: S
): ((input: S["Type"], options?: SchemaAST.ParseOptions) => string) =>
  Schema.encodeSync(Schema.fromJsonString(schema));
