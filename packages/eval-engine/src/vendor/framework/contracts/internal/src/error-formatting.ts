import { Schema } from "effect";
import { makeFormatterStandardSchemaV1 } from "effect/SchemaIssue";

/** A single field-level schema decode failure: where it failed and why. */
interface SchemaIssueDetail {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

const formatStandardSchemaIssues = makeFormatterStandardSchemaV1();

// Bound the walk so a self-referential `cause` chain cannot loop forever.
const MAX_CAUSE_DEPTH = 5;

const asSchemaError = (value: unknown): Schema.SchemaError | undefined => {
  let current = value;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof Schema.SchemaError) {
      return current;
    }
    if (current !== null && typeof current === "object" && "cause" in current) {
      current = (current as { readonly cause: unknown }).cause;
    } else {
      return undefined;
    }
  }
  return undefined;
};

// A Standard Schema issue path is a list of property keys or `{ key }` segments
// (the latter for keyed collections); normalize both to a plain string/number.
type StandardPathSegment = PropertyKey | { readonly key: PropertyKey };

const normalizeIssuePathSegment = (
  segment: StandardPathSegment
): string | number => {
  const key = typeof segment === "object" ? segment.key : segment;
  return typeof key === "number" ? key : String(key);
};

const normalizeIssuePath = (
  path: readonly StandardPathSegment[] | undefined
): readonly (string | number)[] =>
  path === undefined ? [] : path.map(normalizeIssuePathSegment);

/**
 * Project a schema decode failure into the `{ path, message }[]` issue tree so a
 * machine consumer sees which field failed and why, instead of a flattened
 * string. Looks through a tagged error's `cause`, and returns `undefined` for any
 * value that is not (and does not wrap) a schema error.
 */
const formatSchemaIssues = (
  error: unknown
): readonly SchemaIssueDetail[] | undefined => {
  const schemaError = asSchemaError(error);
  if (schemaError === undefined) {
    return undefined;
  }
  const { issues } = formatStandardSchemaIssues(schemaError.issue);
  return issues.map((issue) => ({
    message: issue.message,
    path: normalizeIssuePath(issue.path),
  }));
};

export type { SchemaIssueDetail };
export { formatSchemaIssues };
