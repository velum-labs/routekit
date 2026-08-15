import { Schema } from "effect";

/**
 * Effect Schema mirror of the author-facing root-persona frontmatter shape from
 * `@ori-contracts/author/root-persona`. The root `ori.md` frontmatter is parsed
 * as YAML by the markdown frontmatter reader (so `order` may arrive as a number),
 * then decoded here. `AssertAssignable` keeps the schema Encoded type assignable
 * to the author contract so the two layers cannot drift.
 */
import type { RootPersonaFrontmatter as AuthorRootPersonaFrontmatter } from "../../../author/src/index.ts";
import type { AssertAssignable } from "../type-boundary.ts";

import { ModelSlugSchema } from "./model.ts";

const RootPersonaFrontmatterSchema = Schema.Struct({
  // Additional feature sources to compose with the workspace's own `features/`
  // at boot: local dirs or `github.com/<owner>/<repo>[/path][@ref]` remote paths.
  // Read at the CLI layer (before boot) and fed through the same composition as
  // repeated `--features` flags. The workspace's own `features/` shadows a
  // declared same-named feature; `--features` flags shadow everything.
  features: Schema.optionalKey(
    Schema.UndefinedOr(Schema.Array(Schema.NonEmptyString))
  ),
  harness: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  model: Schema.optionalKey(Schema.UndefinedOr(ModelSlugSchema)),
  name: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  order: Schema.optionalKey(
    Schema.UndefinedOr(Schema.Union([Schema.Finite, Schema.FiniteFromString]))
  ),
  section: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  // Provenance metadata only — the runtime never reads it to gate behavior.
  version: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
});
type _RootPersonaFrontmatterSchemaEncodesAuthor = AssertAssignable<
  typeof RootPersonaFrontmatterSchema.Encoded,
  AuthorRootPersonaFrontmatter
>;

export const decodeRootPersonaFrontmatter = Schema.decodeUnknownEffect(
  RootPersonaFrontmatterSchema,
  {
    onExcessProperty: "error",
  }
);

export { RootPersonaFrontmatterSchema };
