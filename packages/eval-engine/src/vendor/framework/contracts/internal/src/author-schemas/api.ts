import { Schema } from "effect";

/**
 * Effect Schema mirror of author-facing shapes from `@ori-contracts/author`.
 * Authors import the plain TypeScript types; the engine decodes against these
 * schemas. `AssertAssignable` keeps each schema Encoded type assignable to the
 * author contract so the two layers cannot drift.
 */
import type {
  ApiContribution as AuthorApiContribution,
  ApiExports as AuthorApiExports,
  ApiFeatureContext as AuthorApiFeatureContext,
  ApiHooks as AuthorApiHooks,
  ApiRouteHandler as AuthorApiRouteHandler,
} from "../../../author/src/index.ts";
import type { AssertAssignable } from "../type-boundary.ts";

/**
 * The closed set of HTTP methods a route key may name (RFC 0002 api.md). Kept
 * uppercase; a route key is `"METHOD /path"` with exactly one space separating
 * the two halves.
 */
const API_ROUTE_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

const API_ROUTE_METHOD_SET: ReadonlySet<string> = new Set(API_ROUTE_METHODS);

/** A single path segment: a literal, or a `:name` parameter. */
const PATH_SEGMENT_PATTERN = /^(?::[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9._~%-]+)$/u;

interface ParsedRouteKey {
  readonly method: string;
  readonly path: string;
  /** Method + normalized path, used to detect duplicate routes. */
  readonly normalized: string;
}

const findSegmentIssue = (
  key: string,
  segments: readonly string[]
): string | undefined => {
  const paramNames = new Set<string>();
  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0) {
      return `route key "${key}" has an empty path segment (no trailing or doubled slashes)`;
    }
    if (!PATH_SEGMENT_PATTERN.test(segment)) {
      return `route key "${key}" has an invalid path segment "${segment}" at position ${index} (wildcards/regex are reserved)`;
    }
    if (segment.startsWith(":")) {
      const paramName = segment.slice(1);
      if (paramNames.has(paramName)) {
        return `route key "${key}" has a duplicate parameter ":${paramName}"`;
      }
      paramNames.add(paramName);
    }
  }
  return undefined;
};

/**
 * Validate one `"METHOD /path"` route key against the RFC 0002 api.md grammar,
 * returning a parsed form or a human diagnostic string. Rules:
 * - exactly one space between an uppercase method (from the closed set) and path;
 * - path starts with `/`, has segment-exact literals or single-segment `:name`
 *   parameters (unique names within one path); no wildcards/regex/catch-all.
 */
const parseRouteKey = (key: string): ParsedRouteKey | string => {
  const spaceIndex = key.indexOf(" ");
  if (spaceIndex === -1) {
    return `route key "${key}" must be "METHOD /path" (missing space)`;
  }
  const method = key.slice(0, spaceIndex);
  const path = key.slice(spaceIndex + 1);

  if (!API_ROUTE_METHOD_SET.has(method)) {
    return `route key "${key}" has an invalid method "${method}" (expected one of ${API_ROUTE_METHODS.join(", ")})`;
  }
  if (key.slice(spaceIndex + 1).includes(" ")) {
    return `route key "${key}" must have exactly one space between method and path`;
  }
  if (!path.startsWith("/")) {
    return `route key "${key}" path must start with "/"`;
  }

  // A bare "/" (root) yields no segments and is allowed
  // (RFC 0002 api.md: `"GET /"` matches the daemon root exactly).
  const segments = path === "/" ? [] : path.split("/").slice(1);
  const segmentIssue = findSegmentIssue(key, segments);
  if (segmentIssue !== undefined) {
    return segmentIssue;
  }

  // Normalize positionally: parameter NAMES do not disambiguate routes
  // ("GET /items/:id" and "GET /items/:key" normalize to the same route —
  // RFC 0002 api.md), so every `:name` collapses to a bare `:` marker.
  const normalizedPath = segments
    .map((segment) => (segment.startsWith(":") ? ":" : segment))
    .join("/");
  return {
    method,
    normalized: `${method} /${normalizedPath}`,
    path,
  };
};

/** A route handler value: any function. Runtime cannot inspect its signature. */
const routeHandlerSchema = Schema.declare<AuthorApiRouteHandler>(
  (value): value is AuthorApiRouteHandler => typeof value === "function",
  { identifier: "ApiRouteHandler" }
);

/** `exports` is an opaque bag of plain values; the runtime does not interpret it. */
const ApiExportsSchema = Schema.Record(Schema.String, Schema.Unknown);

const ApiHooksRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const ApiHooksSchema = Schema.declare<
  AuthorApiHooks,
  typeof ApiHooksRecordSchema.Encoded
>((value): value is AuthorApiHooks => Schema.is(ApiHooksRecordSchema)(value), {
  identifier: "ApiHooks",
});

/**
 * `routes` is a `Record<"METHOD /path", handler>`. The record shape checks that
 * every value is a function; the `.check` filter enforces the route-key grammar
 * and rejects two keys that normalize to the same method+path — invariants a
 * plain `Schema.Record` cannot express structurally.
 */
const findRouteTableIssue = (
  routes: Readonly<Record<string, unknown>>
): string | undefined => {
  const seen = new Set<string>();
  for (const key of Object.keys(routes)) {
    const parsed = parseRouteKey(key);
    if (typeof parsed === "string") {
      return parsed;
    }
    if (seen.has(parsed.normalized)) {
      return `duplicate route "${parsed.normalized}" (two keys normalize to the same method and path)`;
    }
    seen.add(parsed.normalized);
  }
  return undefined;
};

const ApiRoutesSchema = Schema.Record(Schema.String, routeHandlerSchema).check(
  Schema.makeFilter((routes) => findRouteTableIssue(routes))
);

/**
 * The `api` export: the closed three-key shape
 * `{ exports?, routes?, hooks? }`. The `hooks` key is decoded as a loose
 * provider-hook record; runtime registration and dispatch land separately.
 * Any other top-level key is rejected (`onExcessProperty: "error"` at decode
 * time), which disables the feature with a diagnostic. An empty `{}` is valid —
 * it declares the kind without providing a layer (RFC 0002 api.md).
 */
const ApiContributionSchema = Schema.Struct({
  exports: Schema.optionalKey(Schema.UndefinedOr(ApiExportsSchema)),
  hooks: Schema.optionalKey(Schema.UndefinedOr(ApiHooksSchema)),
  routes: Schema.optionalKey(Schema.UndefinedOr(ApiRoutesSchema)),
});

type ApiContribution = typeof ApiContributionSchema.Type;
type ApiExports = typeof ApiExportsSchema.Type;
type _ApiContributionSchemaEncodesAuthor = AssertAssignable<
  typeof ApiContributionSchema.Encoded,
  AuthorApiContribution
>;
type _ApiExportsSchemaEncodesAuthor = AssertAssignable<
  typeof ApiExportsSchema.Encoded,
  AuthorApiExports
>;

const decodeApiContribution = Schema.decodeUnknownEffect(
  ApiContributionSchema,
  {
    onExcessProperty: "error",
  }
);

/**
 * The author-facing `use` handle type, verbatim. The author contract overloads
 * `use` on the `FeatureApis` declaration-merge registry (RFC 0002 api.md,
 * "Typed `use()`"), so the internal mirror aliases it rather than re-deriving
 * the overload set; the registry implementation performs one declared cast at
 * construction (registrations are declared, not verified).
 */
type ApiFeatureContext = AuthorApiFeatureContext;

export interface ApiRegistryEntry {
  readonly api: ApiContribution;
  readonly featureId: string;
}

export {
  API_ROUTE_METHODS,
  ApiContributionSchema,
  ApiExportsSchema,
  ApiHooksSchema,
  ApiRoutesSchema,
  decodeApiContribution,
  parseRouteKey,
};
export type { ApiContribution, ApiExports, ApiFeatureContext, ParsedRouteKey };
