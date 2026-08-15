import {
  ROUTEKIT_EVAL_AUTHOR_CONTRACTS_DIRECTORY,
  ROUTEKIT_EVAL_DIRECTORY_NAME,
} from "../routekit-eval-directory.ts";

export const AUTHOR_CONTRACTS_PACKAGE = "routekit-eval";
export const AUTHOR_CONTRACTS_RELATIVE_PATH = `${ROUTEKIT_EVAL_DIRECTORY_NAME}/${ROUTEKIT_EVAL_AUTHOR_CONTRACTS_DIRECTORY}`;
export const AUTHOR_CONTRACTS_PACKAGE_VERSION = `file:${AUTHOR_CONTRACTS_RELATIVE_PATH}`;

// The generated `routekit-eval` SDK re-exports `Schema` from `effect`, so the SDK and any
// scaffolded workspace depend on it. Keep this pinned to the monorepo's effect
// version (see the root package.json).
export const EFFECT_PACKAGE = "effect";
export const EFFECT_PACKAGE_VERSION = "4.0.0-beta.90";

// RFC 0002 (Harness Authoring Surface): the generated `routekit-eval/process` runtime
// plumbing uses Node's process runtime, so the generated SDK also declares
// `@effect/platform-node` (version-matched to `effect`). This is the only new
// runtime dependency the SDK gains.
export const PLATFORM_NODE_PACKAGE = "@effect/platform-node";
// Version-matched to `effect` (same monorepo pin); kept as a literal rather than
// aliasing EFFECT_PACKAGE_VERSION so the two are distinct exports.
export const PLATFORM_NODE_PACKAGE_VERSION = "4.0.0-beta.90";
// Deprecated aliases for unowned importers that still use the Bun names.
export const PLATFORM_BUN_PACKAGE = PLATFORM_NODE_PACKAGE;
export const PLATFORM_BUN_PACKAGE_VERSION = PLATFORM_NODE_PACKAGE_VERSION;

// RFC 0002 api.md ("Typed `use()`"): the generated `routekit-eval` SDK ships the slack
// built-in's `use("slack")` provider type (see
// tools/scripts/built-in-feature-apis-source.ts). Its `blocks` field is typed
// against `@slack/types` — the types-only package that `@slack/web-api`
// re-exports Block Kit from — so authors get real Block Kit autocomplete
// without depending on `@routekit-eval-builtins/slack`. Pinned to the version
// `@routekit-eval-builtins/slack`'s `@slack/web-api` resolves, so the shipped type is
// identical to the one `postMessage` actually accepts.
export const SLACK_TYPES_PACKAGE = "@slack/types";
export const SLACK_TYPES_PACKAGE_VERSION = "2.22.0";
