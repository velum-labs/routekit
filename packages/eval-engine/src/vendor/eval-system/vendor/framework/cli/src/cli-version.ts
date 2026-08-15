import { Effect, Schema } from "effect";

/**
 * Default package name used when a manifest or build-time define omits `name`.
 * Owned here so the schema's decoding default and the build-info fallback share
 * one source of truth.
 */
export const DEFAULT_NAME = "routekit-eval";

/**
 * The CLI's reported identity: package `name` and `version`. Source of truth for
 * both the `package.json` read (`version-info.ts`) and the compiled build-time
 * define read (`build-info.ts`). `name` is `optionalKey` on the encoded side — a
 * `package.json` may omit it — and decode-defaults to {@link DEFAULT_NAME}, so the
 * decoded `Type` always carries a concrete `name`.
 */
export const CliVersionSchema = Schema.Struct({
  name: Schema.NonEmptyString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_NAME))
  ),
  version: Schema.NonEmptyString,
});

export type CliVersion = typeof CliVersionSchema.Type;
