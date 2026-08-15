import { Schema } from "effect";

/**
 * Effect Schema mirror of author-facing shapes from `@routekit-eval-contracts/author`.
 * Authors import the plain TypeScript types; the engine decodes against these
 * schemas. `AssertAssignable` keeps each schema Encoded type assignable to the
 * author contract so the two layers cannot drift.
 */
import type {
  SkillDocument as AuthorSkillDocument,
  SkillFrontmatter as AuthorSkillFrontmatter,
  SkillMetadata as AuthorSkillMetadata,
} from "../../../author/src/index.ts";
import type { AssertAssignable } from "../type-boundary.ts";

// The spec's metadata map is string-valued, but YAML authors naturally write
// an unquoted version pin, so both the integer and its string form decode to
// a positive integer.
const ManagedSkillVersionSchema = Schema.Union([
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.FiniteFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1)
  ),
]);

// A pointer names a managed skill by canonical id (`skill_...`, via
// `gateway-skill-id`) or by its workspace-scoped slug (`pdf-extract`, via
// `gateway-skill-slug`). Pointers are used as cache directory segments, so
// they must be safe path components: alphanumerics, `_`, and `-` only (no
// separators or dots).
const MANAGED_SKILL_POINTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const ManagedSkillPointerSchema = Schema.String.check(
  Schema.isPattern(MANAGED_SKILL_POINTER_PATTERN)
);

const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SKILL_NAME_MAX_LENGTH = 64;
const SkillCommandAliasSchema = Schema.String.check(
  Schema.isLengthBetween(1, SKILL_NAME_MAX_LENGTH),
  Schema.isPattern(SKILL_NAME_PATTERN)
);

// Agent Skills spec `metadata` map. Managed skill pointer keys and the
// command-aliases escape hatch are modelled; other metadata keys pass through the
// excess-property ignore below. A pointer names its managed skill by id or slug,
// never both:
// the two carry different identity guarantees (a canonical id is globally
// unique; a slug is workspace-scoped), so a file that sets both is ambiguous
// and is rejected here rather than silently resolved by id precedence.
const SkillMetadataSchema = Schema.Struct({
  "gateway-skill-id": Schema.optionalKey(ManagedSkillPointerSchema),
  "gateway-skill-slug": Schema.optionalKey(ManagedSkillPointerSchema),
  "gateway-skill-version": Schema.optionalKey(ManagedSkillVersionSchema),
  "command-aliases": Schema.optionalKey(Schema.Array(SkillCommandAliasSchema)),
}).check(
  Schema.makeFilter((metadata) =>
    metadata["gateway-skill-id"] !== undefined &&
    metadata["gateway-skill-slug"] !== undefined
      ? "a managed skill pointer must set at most one of `gateway-skill-id` and `gateway-skill-slug`, not both"
      : undefined
  )
);
type SkillMetadata = typeof SkillMetadataSchema.Type;
type _SkillMetadataSchemaEncodesAuthor = AssertAssignable<
  AuthorSkillMetadata,
  typeof SkillMetadataSchema.Encoded
>;

const SkillFrontmatterSchema = Schema.Struct({
  "allowed-tools": Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Array(Schema.String)])
  ),
  // Optional at the schema level because a managed skill pointer may omit them
  // (they resolve from the published SKILL.md); the importer requires them for
  // native skills and after pointer resolution.
  description: Schema.optionalKey(Schema.NonEmptyString),
  metadata: Schema.optionalKey(SkillMetadataSchema),
  name: Schema.optionalKey(Schema.NonEmptyString),
});
type _SkillFrontmatterSchemaEncodesAuthor = AssertAssignable<
  typeof SkillFrontmatterSchema.Encoded,
  AuthorSkillFrontmatter
>;

// Skills are often ported from other agent formats that carry extra frontmatter
// keys; ignore unknown keys instead of failing, while still validating the keys
// we model (e.g. `allowed-tools`).
const decodeSkillFrontmatter = Schema.decodeUnknownEffect(
  SkillFrontmatterSchema,
  {
    onExcessProperty: "ignore",
  }
);

interface SkillRegistryEntry {
  readonly "allowed-tools"?: string | readonly string[];
  readonly body: string;
  readonly commandAliases?: readonly string[];
  readonly description: string;
  readonly featureId: string;
  readonly metadata?: AuthorSkillMetadata | undefined;
  readonly name: string;
  readonly sourceDir?: string | undefined;
  readonly sourcePath: string;
}
type _SkillRegistryEntryContainsAuthorDocument = AssertAssignable<
  SkillRegistryEntry,
  AuthorSkillDocument
>;

/**
 * A managed skill pointer resolved from frontmatter: either the canonical id
 * (`gateway-skill-id`, globally unique) or the workspace-scoped slug
 * (`gateway-skill-slug`). The `kind` is retained past resolution because it
 * governs cache scoping — an id is safe to share across workspaces under one
 * `$HOME`, a slug is not (RFC 0002 skill.md).
 */
interface ManagedSkillPointer {
  readonly kind: "id" | "slug";
  readonly value: string;
}

// The schema rejects a file that sets both keys, so at most one is present; id
// is checked first so a value is still chosen deterministically if that
// invariant is ever relaxed.
const managedSkillPointerFromMetadata = (
  metadata: SkillMetadata | undefined
): ManagedSkillPointer | undefined => {
  const id = metadata?.["gateway-skill-id"];
  if (id !== undefined) {
    return {
      kind: "id",
      value: id,
    };
  }
  const slug = metadata?.["gateway-skill-slug"];
  if (slug !== undefined) {
    return {
      kind: "slug",
      value: slug,
    };
  }
  return undefined;
};

const commandAliasesFromMetadata = (
  metadata: SkillMetadata | undefined
): readonly string[] =>
  metadata?.["command-aliases"] === undefined
    ? []
    : [...new Set(metadata["command-aliases"])];

export {
  SkillFrontmatterSchema,
  commandAliasesFromMetadata,
  decodeSkillFrontmatter,
  managedSkillPointerFromMetadata,
};
export type { ManagedSkillPointer, SkillRegistryEntry };
