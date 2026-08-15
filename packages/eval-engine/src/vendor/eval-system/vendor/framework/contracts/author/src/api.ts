import type { FeatureLogger } from "./feature-logger.ts";
import type { ApiHooks } from "./hooks-handles.ts";
import type { McpResolver } from "./mcp.ts";
import type { StoreResolver } from "./stores.ts";

/** Values a provider feature exposes to dependents via `use(featureId)`. */
export type ApiExports = Readonly<Record<string, unknown>>;

/**
 * Feature-id-keyed registry of provider export types. Empty by default;
 * populated by declaration merging (RFC 0002 api.md, "Typed `use()`"):
 *
 *   declare module "routekit-eval" {
 *     interface FeatureApis {
 *       billing: (typeof api)["exports"];
 *     }
 *   }
 *
 * Two paths fill it. Workspace features are generated into the `.routekit-eval/` cache
 * from their own source. Built-ins have no file in the consumer's workspace, so
 * their provider type is baked into the generated `routekit-eval` SDK itself during
 * `contracts:generate` — that is how `use("slack")` resolves to the slack
 * built-in's `postMessage` shape without depending on `@routekit-eval-builtins/slack`.
 *
 * Registrations are declared, not verified: the runtime never checks the
 * provider's value against the registered type.
 */
// oxlint-disable-next-line no-empty-object-type, no-empty-interface -- declaration-merge target by design
export interface FeatureApis {}

/**
 * Handle for calling other features' `api.exports`. Any feature may `use()`
 * any other registered feature; no per-pair dependency declaration is
 * required. A registered feature id (a `FeatureApis` key) infers the
 * provider's export type; a dynamic or unregistered id falls back to the
 * explicit type parameter.
 */
export interface ApiFeatureContext {
  readonly use: (<K extends Extract<keyof FeatureApis, string>>(
    featureId: K
  ) => Promise<FeatureApis[K]>) &
    (<T extends ApiExports = ApiExports>(featureId: string) => Promise<T>);
}

/** Per-request context injected into a route handler. */
export interface ApiRouteContext {
  /** The owning feature's id (its directory name). */
  readonly featureId: string;
  /** Diagnostic logger pre-scoped to the owning feature (RFC 0011). */
  readonly logger: FeatureLogger;
  /**
   * Reach an MCP server declared in the workspace `mcp.json`. Optional: present
   * only when the host wired MCP for this run, so a handler guards before use.
   */
  readonly mcp?: McpResolver | undefined;
  /** Path parameters captured from `:name` segments in the route key. */
  readonly params: Readonly<Record<string, string>>;
  /**
   * The caller's remote IP address as the daemon saw it, or `undefined` when
   * unavailable. Lets an internal route enforce a loopback-only trust boundary
   * in-handler instead of trusting the daemon's bind address.
   */
  readonly remoteAddress: string | undefined;
  /**
   * Framework state store access (Feature State Store Access, RFC 0005). Route
   * handlers run in-daemon, so this is populated with the resolved in-process
   * store; a handler persists through it instead of opening its own database.
   */
  readonly stores?: StoreResolver | undefined;
  /** Call another feature's `api.exports`. */
  readonly use: ApiFeatureContext["use"];
}

/** One HTTP route handler: web-standard Request in, Response out. */
export type ApiRouteHandler = (
  request: Request,
  context: ApiRouteContext
) => Promise<Response> | Response;

/**
 * Declarative route table keyed by `"METHOD /path"`. The path is the public
 * path: the daemon serves it verbatim at its root (RFC 0002 api.md).
 */
export type ApiRoutes = Readonly<Record<string, ApiRouteHandler>>;

export interface ApiContribution {
  readonly exports?: ApiExports | undefined;
  readonly hooks?: ApiHooks | undefined;
  readonly routes?: ApiRoutes | undefined;
}
