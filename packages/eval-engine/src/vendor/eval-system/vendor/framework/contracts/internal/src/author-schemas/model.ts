import type { FastCheck } from "effect/testing";

import { Schema } from "effect";

import type {
  ModelSlug as AuthorModelSlug,
  ModelValue as AuthorModelValue,
} from "../../../author/src/index.ts";
import type { AssertAssignable } from "../type-boundary.ts";

type ModelSlug = AuthorModelSlug;

type ModelValue = ModelSlug | null;
type _ModelValueEncodesAuthor = AssertAssignable<ModelValue, AuthorModelValue>;

interface ModelRegistryEntry {
  readonly model: ModelValue;
  readonly name: string;
}

const MODEL_SLUG_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const NO_SLASH_OR_SPACE_PATTERN = /^[^/\s]+$/u;

const isModelSlug = (value: unknown): value is ModelSlug =>
  typeof value === "string" && MODEL_SLUG_PATTERN.test(value);

// A plain `Schema.String.check(Schema.isPattern(...))` cannot narrow the Type
// side to the `${string}/${string}` template-literal `ModelSlug`, so this
// stays a `declare`. That opaque node has no generator by default (`Unsupported
// AST Declaration`); `toArbitrary` builds two non-slash/non-space halves and
// joins them, then `.filter(isModelSlug)` narrows the arbitrary's type back
// to `ModelSlug` using the same guard the schema decodes with.
const ModelSlugSchema = Schema.declare<ModelSlug>(isModelSlug, {
  identifier: "GatewayModelSlug",
  toArbitrary:
    () =>
    (fc): FastCheck.Arbitrary<ModelSlug> =>
      fc
        .tuple(
          fc.stringMatching(NO_SLASH_OR_SPACE_PATTERN),
          fc.stringMatching(NO_SLASH_OR_SPACE_PATTERN)
        )
        .map(([provider, slug]) => `${provider}/${slug}`)
        .filter(isModelSlug),
});
type _ModelSlugSchemaEncodesAuthor = AssertAssignable<
  typeof ModelSlugSchema.Type,
  AuthorModelSlug
>;

const ModelValueSchema = Schema.NullOr(ModelSlugSchema);
type _ModelValueSchemaEncodesAuthor = AssertAssignable<
  typeof ModelValueSchema.Type,
  AuthorModelValue
>;

export { ModelSlugSchema, ModelValueSchema };
export type { ModelSlug, ModelValue, ModelRegistryEntry };
