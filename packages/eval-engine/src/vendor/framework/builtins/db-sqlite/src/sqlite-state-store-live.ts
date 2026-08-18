import { Effect, Layer } from "effect";

import type {
  SqliteStateStoreConfig,
  SqliteStateStoreOptions,
} from "./sqlite-state-store.ts";

import {
  makeSqliteStateStoreScoped,
  SqliteStateStore,
} from "./sqlite-state-store.ts";

/**
 * The live {@link SqliteStateStore} adapter. A factory (not a bare `const`
 * layer) because the sqlite path is a runtime `config` binding, not a `Config`
 * value.
 *
 * Lifecycle: the node:sqlite handle opens lazily on first use and is torn down by
 * the `acquireRelease` finalizer inside `makeSqliteStateStoreScoped`, whose
 * `close` releases the handle. `Layer.effect` absorbs the `Scope` that finalizer
 * needs (it runs its construction effect scoped and excludes `Scope` from the
 * layer's requirements), so the handle is finalized deterministically when this
 * layer's scope closes rather than left for GC. When `options` is omitted, store
 * effects run on the captured Effect context via `Effect.runPromiseWith`,
 * matching how the runtime threads its context through the store today.
 *
 * Wired at the composition root: `builtInSqliteStateStoreLayer`
 * (`built-in-catalog/db.ts`) resolves the workspace-root config binding and
 * hands it to this factory, supplying the `SqliteStateStore` tag that
 * `BuiltInDbCatalog` yields.
 */
export const SqliteStateStoreLive = (
  config: SqliteStateStoreConfig,
  options?: SqliteStateStoreOptions
): Layer.Layer<SqliteStateStore> =>
  Layer.effect(SqliteStateStore)(
    Effect.gen(function* () {
      const context = yield* Effect.context();
      const store = yield* makeSqliteStateStoreScoped(
        config,
        options ?? { runEffect: Effect.runPromiseWith(context) }
      );
      return SqliteStateStore.of(store);
    })
  );
