import { Schema } from "effect";

/**
 * Effect Schema mirror of author-facing shapes from `@routekit-eval-contracts/author`.
 * Authors import the plain TypeScript types; the engine decodes against these
 * schemas. `AssertAssignable` keeps each schema Encoded type assignable to the
 * author contract so the two layers cannot drift.
 */
import type {
  PromptContext as AuthorPromptContext,
  PromptFragment as AuthorPromptFragment,
  PromptFrontmatter as AuthorPromptFrontmatter,
  PromptModuleMetadata as AuthorPromptModuleMetadata,
  PromptProvider as AuthorPromptProvider,
  FeatureLogger,
  StateStore,
  StoreResolver,
} from "../../../author/src/index.ts";
import type { AssertAssignable } from "../type-boundary.ts";

interface PromptContext {
  readonly logger?: FeatureLogger | undefined;
  readonly prompt: string;
  readonly sessionId?: string | undefined;
  readonly state: StateStore;
  readonly stores?: StoreResolver | undefined;
}
type _PromptContextEncodesAuthor = AssertAssignable<
  PromptContext,
  AuthorPromptContext
>;

interface PromptFragmentObject {
  readonly name?: string | undefined;
  readonly order?: number | undefined;
  readonly section?: string | undefined;
  readonly text: string;
}

type PromptFragment = string | PromptFragmentObject;

type PromptProvider = (
  ctx: PromptContext
) =>
  | PromptFragment
  | readonly PromptFragment[]
  | Promise<PromptFragment | readonly PromptFragment[]>;
type _PromptProviderEncodesAuthor = AssertAssignable<
  PromptProvider,
  AuthorPromptProvider
>;

const PromptFragmentObjectSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  order: Schema.optionalKey(Schema.UndefinedOr(Schema.Finite)),
  section: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  text: Schema.String,
});

const PromptFragmentSchema = Schema.Union([
  Schema.String,
  PromptFragmentObjectSchema,
]);
type _PromptFragmentSchemaEncodesAuthor = AssertAssignable<
  typeof PromptFragmentSchema.Encoded,
  AuthorPromptFragment
>;

const PromptProviderResultSchema = Schema.ArrayEnsure(PromptFragmentSchema);
type _PromptProviderResultSchemaEncodesAuthor = AssertAssignable<
  typeof PromptProviderResultSchema.Type,
  readonly AuthorPromptFragment[]
>;

const PromptProviderSchema = Schema.declare<PromptProvider>(
  (value): value is PromptProvider => typeof value === "function",
  { identifier: "PromptProvider" }
);
type PromptProviderShape = typeof PromptProviderSchema.Type;

const PromptFrontmatterSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  // Frontmatter is parsed as real YAML, so `order: 5` arrives as a number; accept
  // a quoted `order: "5"` too for backward compatibility.
  order: Schema.optionalKey(
    Schema.UndefinedOr(Schema.Union([Schema.Finite, Schema.FiniteFromString]))
  ),
  section: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
});
type _PromptFrontmatterSchemaEncodesAuthor = AssertAssignable<
  typeof PromptFrontmatterSchema.Encoded,
  AuthorPromptFrontmatter
>;

const PromptModuleMetadataSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  order: Schema.optionalKey(Schema.UndefinedOr(Schema.Finite)),
});
type _PromptModuleMetadataSchemaEncodesAuthor = AssertAssignable<
  typeof PromptModuleMetadataSchema.Encoded,
  AuthorPromptModuleMetadata
>;

export interface PromptEntryBase {
  readonly name: string;
  readonly order: number;
  readonly section?: string | undefined;
}

export interface StaticPromptEntry extends PromptEntryBase {
  readonly text: string;
  readonly type: "static";
}

export interface DynamicPromptEntry extends PromptEntryBase {
  readonly provider: PromptProvider;
  readonly type: "dynamic";
}

export type PromptRegistryEntry = StaticPromptEntry | DynamicPromptEntry;

export const decodePromptFrontmatter = Schema.decodeUnknownEffect(
  PromptFrontmatterSchema,
  {
    onExcessProperty: "error",
  }
);

export const decodePromptModuleMetadata = Schema.decodeUnknownEffect(
  PromptModuleMetadataSchema,
  {
    onExcessProperty: "error",
  }
);

export const decodePromptProviderShape =
  Schema.decodeUnknownEffect(PromptProviderSchema);

export const decodePromptProviderResult = Schema.decodeUnknownEffect(
  PromptProviderResultSchema,
  {
    onExcessProperty: "error",
  }
);

export {
  PromptFragmentObjectSchema,
  PromptFragmentSchema,
  PromptProviderResultSchema,
  PromptProviderSchema,
  PromptFrontmatterSchema,
  PromptModuleMetadataSchema,
};
export type {
  PromptContext,
  PromptFragmentObject,
  PromptFragment,
  PromptProvider,
  PromptProviderShape,
};
