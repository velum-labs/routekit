// Kept apart from `daemon-api-feature-routes.ts` so the matching grammar can be
// unit-tested in isolation, mirroring the pure helpers in `daemon-http-response.ts`.

import { API_ROUTE_METHODS } from "../../../../contracts/internal/src/author-schemas/api.ts";

/** A route table: `"METHOD /path"` keys mapping to handler values. */
export type RouteTable<Handler> = Readonly<Record<string, Handler>>;

export interface RouteMatch<Handler> {
  readonly handler: Handler;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * The outcome of matching a request against a route table:
 * - `Matched` — a route matched the method and path; carries its handler + params.
 * - `MethodNotAllowed` — the path matched at least one route but not the method;
 *   `allow` lists the methods that DO match this path (for the `Allow` header).
 * - `NotFound` — no route path matched at all.
 */
export type RouteMatchResult<Handler> =
  | { readonly kind: "Matched"; readonly match: RouteMatch<Handler> }
  | { readonly kind: "MethodNotAllowed"; readonly allow: readonly string[] }
  | { readonly kind: "NotFound" };

interface ParsedRoute<Handler> {
  readonly handler: Handler;
  readonly method: string;
  readonly segments: readonly string[];
}

/**
 * Split a `/`-prefixed request path into segments with NO trailing-slash
 * equivalence (RFC 0002 api.md): `/` yields `[]`, `/a` yields `["a"]`, and
 * `/a/` yields `["a", ""]` — the trailing empty segment can never match a
 * route segment (route grammar forbids empty segments), so `GET /a` and
 * `GET /a/` stay distinct.
 */
const pathSegments = (path: string): readonly string[] =>
  path === "/" ? [] : path.split("/").slice(1);

const parseRouteEntry = <Handler>(
  key: string,
  handler: Handler
): ParsedRoute<Handler> | undefined => {
  const spaceIndex = key.indexOf(" ");
  if (spaceIndex === -1) {
    return undefined;
  }
  const method = key.slice(0, spaceIndex);
  const path = key.slice(spaceIndex + 1);
  return {
    handler,
    method,
    segments: pathSegments(path),
  };
};

/**
 * Percent-decode one captured `:name` segment. A segment that fails to decode
 * is treated as no match (RFC 0002 api.md), never as an error.
 */
const decodeParamSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/**
 * Match `requestPath`'s segments against a route's segments, capturing `:name`
 * parameters. Segment-exact: equal length, literals must match verbatim, a
 * `:name` segment captures exactly one non-empty segment (percent-decoded).
 * Returns the captured params, or `undefined` when the path does not match.
 */
const matchSegments = (
  routeSegments: readonly string[],
  requestSegments: readonly string[]
): Record<string, string> | undefined => {
  if (routeSegments.length !== requestSegments.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [index, routeSegment] of routeSegments.entries()) {
    const requestSegment = requestSegments[index] ?? "";
    if (routeSegment.startsWith(":")) {
      if (requestSegment.length === 0) {
        return undefined;
      }
      const decoded = decodeParamSegment(requestSegment);
      if (decoded === undefined) {
        return undefined;
      }
      params[routeSegment.slice(1)] = decoded;
      continue;
    }
    if (routeSegment !== requestSegment) {
      return undefined;
    }
  }
  return params;
};

/**
 * Literal-first precedence (RFC 0002 api.md): when two routes match the same
 * request path, the one with a literal at the first position where they differ
 * wins, regardless of declaration order. Returns a negative number when `left`
 * is more specific. Two routes identical in shape normalize to the same route
 * and are rejected at boot, so a tie cannot reach a real dispatch.
 */
const compareSpecificity = (
  left: readonly string[],
  right: readonly string[]
): number => {
  for (const [index, leftSegment] of left.entries()) {
    const leftIsParam = leftSegment.startsWith(":");
    const rightIsParam = (right[index] ?? "").startsWith(":");
    if (leftIsParam !== rightIsParam) {
      return leftIsParam ? 1 : -1;
    }
  }
  return 0;
};

/**
 * Match a request `method` + `path` against a route table (RFC 0002 api.md).
 * Path matching is segment-exact with single-segment `:name` params and
 * literal-first precedence; a path that matches but on a different method
 * yields `MethodNotAllowed` with the set of methods that DO match (in
 * canonical method order, for a stable `Allow` header).
 *
 * The route keys are assumed already validated at boot by the `api` schema, so
 * an unparseable key is skipped defensively rather than treated as an error.
 */
interface BestRouteMatch<Handler> {
  readonly match: RouteMatch<Handler>;
  readonly segments: readonly string[];
}

const foldMatchingRoute = <Handler>(input: {
  readonly allowed: Set<string>;
  readonly best: BestRouteMatch<Handler> | undefined;
  readonly handler: Handler;
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  readonly parsed: {
    readonly method: string;
    readonly segments: readonly string[];
  };
}): BestRouteMatch<Handler> | undefined => {
  if (input.parsed.method !== input.method) {
    input.allowed.add(input.parsed.method);
    return input.best;
  }
  if (
    input.best !== undefined &&
    compareSpecificity(input.parsed.segments, input.best.segments) >= 0
  ) {
    return input.best;
  }
  return {
    match: {
      handler: input.handler,
      params: input.params,
    },
    segments: input.parsed.segments,
  };
};

export const matchApiRoute = <Handler>(
  routes: RouteTable<Handler>,
  method: string,
  path: string
): RouteMatchResult<Handler> => {
  const requestSegments = pathSegments(path);
  const allowed = new Set<string>();
  let best: BestRouteMatch<Handler> | undefined;

  for (const [key, handler] of Object.entries(routes)) {
    const parsed = parseRouteEntry(key, handler);
    if (parsed === undefined) {
      continue;
    }
    const params = matchSegments(parsed.segments, requestSegments);
    if (params === undefined) {
      continue;
    }
    best = foldMatchingRoute({
      allowed,
      best,
      handler,
      method,
      params,
      parsed,
    });
  }

  if (best !== undefined) {
    return {
      kind: "Matched",
      match: best.match,
    };
  }
  if (allowed.size > 0) {
    return {
      allow: API_ROUTE_METHODS.filter((candidate) => allowed.has(candidate)),
      kind: "MethodNotAllowed",
    };
  }
  return { kind: "NotFound" };
};
