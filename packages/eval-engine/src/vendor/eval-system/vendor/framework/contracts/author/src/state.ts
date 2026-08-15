// RFC 0005 feature-store-access.md: the process-global state store surface.
//
// A `StoreResolver` (see ./stores.ts) is injected into the handler contexts that
// carry one (`ctx.stores`, `chat.stores`). This module adds a *process-global*
// counterpart: a bare `db` an author can import directly —
//
//   import { db } from "routekit-eval/state";
//   const store = await db();
//   await store.exec("CREATE TABLE IF NOT EXISTS threads (...)");
//
// — for the many call sites that have no handler context in scope (module-level
// init, a chat surface's `start()` before any turn). `db(name?)` resolves the
// named store, or the default when omitted, and returns the same `StateStore`
// the injected `stores` handle resolves in that process.
//
// IMPORTANT — cross-realm rendezvous. The host runtime and a feature's vendored
// `routekit-eval` SDK are SEPARATE module graphs (the feature imports the generated
// `.routekit-eval/sdk` copy, not this source). A plain module-level singleton set by the
// host would therefore be invisible to the feature. So the active resolver lives
// on a well-known `globalThis` slot keyed by a `Symbol.for` registry symbol,
// which every realm shares. The host installs the resolver once per scoped
// runtime (see the runloop state wiring).
//
// Unlike `routekit-eval/logger`, the pre-install default REJECTS rather than no-ops: a
// logger that drops a record is harmless, but a store that silently accepts
// writes and returns empty reads corrupts feature state invisibly. So before the
// host installs a resolver — and in any standalone/test context — `db()` rejects
// with a clear error. A feature that persists state handles this like any other
// failed I/O.
//
// This module MUST NOT import `effect` or `@routekit-eval-engine/*`; it ships inside the
// author-facing `routekit-eval` SDK, which is effect-free by contract (RFC 0002 / 0007).
// The host does all Effect bridging on its side before calling installFeatureState.

import type { StateStore, StoreResolver } from "./stores.ts";

/**
 * The `globalThis` registry key the active store resolver is published under.
 * `Symbol.for` returns the same symbol across every module realm in the process,
 * so the host's install and a feature's `db()` calls rendezvous on one slot even
 * though they live in different module graphs.
 */
const FEATURE_STATE_GLOBAL_KEY = Symbol.for("routekit-eval/feature-state/v1");

interface FeatureStateGlobal {
  current?: StoreResolver | undefined;
}

/** Read (creating on first use) the shared global slot. */
const slot = (): FeatureStateGlobal => {
  const host: Record<symbol, FeatureStateGlobal | undefined> = globalThis;
  const existing = host[FEATURE_STATE_GLOBAL_KEY];
  if (existing) {
    return existing;
  }
  const created: FeatureStateGlobal = {};
  host[FEATURE_STATE_GLOBAL_KEY] = created;
  return created;
};

const NO_RESOLVER_MESSAGE =
  "no state store is available in this context: routekit-eval/state has no resolver installed (call db() from a running feature, not at import time)";

/**
 * Resolve a framework {@link StateStore}. `db()` returns the default store;
 * `db(name)` returns the store registered under that name. Reads the active
 * resolver on EVERY call (never captures it), so a resolver installed after a
 * module imported `db` still takes effect. Rejects when no resolver is installed
 * rather than returning a store that silently loses writes.
 */
export const db = (name?: string): Promise<StateStore> => {
  const resolver = slot().current;
  if (resolver === undefined) {
    return Promise.reject(new Error(NO_RESOLVER_MESSAGE));
  }
  return name === undefined
    ? Promise.resolve(resolver.state)
    : resolver.db(name);
};

/**
 * Install the host's {@link StoreResolver} as the active global implementation
 * and return a restore closure that reverts to the *prior* occupant on release.
 *
 * **Use the returned closure** (not `resetFeatureState`) to release the install
 * from a scoped runtime. This saves and restores the previous value, so two
 * concurrent runtimes in one process (e.g. the CLI core layer + an in-process
 * daemon under `routekit-eval dev`) each release cleanly without blanking the other's
 * install. This is a host-only hook, kept off the bare `routekit-eval` surface so a
 * feature cannot hijack the store slot.
 */
export const installFeatureState = (resolver: StoreResolver): (() => void) => {
  const s = slot();
  const prev = s.current;
  s.current = resolver;
  return () => {
    s.current = prev;
  };
};

/**
 * Unconditionally clear the active global resolver, reverting `db()` to the
 * reject default. Use this for hard reset (standalone teardown, test cleanup);
 * prefer the restore closure returned by `installFeatureState` for scoped
 * runtimes.
 */
export const resetFeatureState = (): void => {
  slot().current = undefined;
};
