import type { SQLInputValue, StatementResultingChanges } from "node:sqlite";
import type { Scope } from "effect";
import type { StateStore } from "../../routekit-eval/src/index.ts";

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Config, Context, Data, Effect, Layer, Option, Schema } from "effect";

import { formatUnknownError } from "../../../utils/core/src/error-formatting.ts";

const SQLITE_STORE_NAME = "sqlite";
const SQLITE_STATE_FILE = "state.sqlite";

const DEFAULT_STATE_DIR = ".routekit-eval";
const FOREIGN_KEYS_PRAGMA = "PRAGMA foreign_keys = ON";
const JOURNAL_MODE_PRAGMA = "PRAGMA journal_mode = WAL";
const ROUTEKIT_EVAL_SQLITE_PATH_ENV = "ROUTEKIT_EVAL_SQLITE_PATH";
const ROUTEKIT_EVAL_STATE_DIR_ENV = "ROUTEKIT_EVAL_STATE_DIR";
const RESERVED_KV_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS routeKitEval_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;
const READ_KV_SQL = "SELECT value FROM routeKitEval_kv WHERE key = ?";
const UPSERT_KV_SQL = `
INSERT INTO routeKitEval_kv (key, value)
VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

interface SqliteStateStoreConfig {
  readonly path: string;
}

interface SqliteStateStoreOptions {
  readonly runEffect: <Value>(
    effect: Effect.Effect<Value, Error>
  ) => Promise<Value>;
}

type PositionalSqliteBinding =
  | NodeJS.TypedArray
  | bigint
  | boolean
  | null
  | number
  | string;

const NonEmptyEnvValueSchema = Schema.Trim.pipe(
  Schema.decodeTo(Schema.NonEmptyString)
);
const decodeEnvValueOption = Schema.decodeUnknownOption(NonEmptyEnvValueSchema);

const normalizeEnvValue = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return;
  }
  return Option.getOrUndefined(decodeEnvValueOption(value));
};

const readSqliteStateStoreConfig = (
  env: Readonly<Record<string, string | undefined>>,
  cwd = "."
): SqliteStateStoreConfig => {
  const explicitPath = normalizeEnvValue(env[ROUTEKIT_EVAL_SQLITE_PATH_ENV]);
  if (explicitPath !== undefined) {
    return { path: explicitPath };
  }

  const stateDir =
    normalizeEnvValue(env[ROUTEKIT_EVAL_STATE_DIR_ENV]) ?? join(cwd, DEFAULT_STATE_DIR);
  return { path: join(stateDir, SQLITE_STATE_FILE) };
};

const readOptionalConfigString = (
  name: string
): Effect.Effect<string | undefined, Config.ConfigError> =>
  Config.string(name).pipe(
    Config.option,
    Effect.map((value) =>
      Option.isSome(value) ? normalizeEnvValue(value.value) : undefined
    )
  );

const readSqliteStateStoreConfigFromConfig = Effect.fn(
  "readSqliteStateStoreConfigFromConfig"
)(function* (cwd?: string) {
  const explicitPath = yield* readOptionalConfigString(ROUTEKIT_EVAL_SQLITE_PATH_ENV);
  if (explicitPath !== undefined) {
    return { path: explicitPath };
  }

  const stateDir =
    (yield* readOptionalConfigString(ROUTEKIT_EVAL_STATE_DIR_ENV)) ??
    join(cwd ?? ".", DEFAULT_STATE_DIR);
  return { path: join(stateDir, SQLITE_STATE_FILE) };
});

const isTypedArray = (value: unknown): value is NodeJS.TypedArray =>
  ArrayBuffer.isView(value) && !(value instanceof DataView);

const SqliteBindingSchema = Schema.declare<PositionalSqliteBinding>(
  (value): value is PositionalSqliteBinding =>
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    isTypedArray(value),
  { identifier: "PositionalSqliteBinding" }
);
const SqliteParamsSchema = Schema.Array(SqliteBindingSchema);
const decodeSqliteParams = Schema.decodeUnknownSync(SqliteParamsSchema);

// The reserved `routeKitEval_kv` table is `value TEXT NOT NULL` and only ever written a
// string by `set`, but `.all()` hands back untyped rows: decode the store's own
// internal read at this boundary rather than trusting an unchecked field access.
const KvRowSchema = Schema.Struct({ value: Schema.String });
const decodeKvRowOption = Schema.decodeUnknownOption(KvRowSchema);

// Named so the inert `layerTest.get` returns it without a bare `undefined`
// call argument, which `unicorn/no-useless-undefined` would strip (dropping the
// return type to `void`); mirrors `makeNoopStateStore`'s `missingStateValue`.
const missingStateValue: string | undefined = undefined;

// Project the `routeKitEval_kv` read to its value. An absent row is a genuine key miss.
// A present row that fails to decode is out-of-band (`routeKitEval_kv.value` is
// `TEXT NOT NULL` and only `set` writes it), so it degrades to a miss too — but
// emit a debug log first, so a corrupt row is observable rather than silently
// indistinguishable from an absent key.
const readKvValue = (
  key: string,
  row: unknown
): Effect.Effect<string | undefined> =>
  row === undefined
    ? Effect.succeed(missingStateValue)
    : Option.match(decodeKvRowOption(row), {
        onNone: () =>
          Effect.logDebug(
            `sqlite routeKitEval_kv row for "${key}" failed to decode`
          ).pipe(Effect.as(missingStateValue)),
        onSome: (kv) => Effect.succeed(kv.value),
      });

const bindParams = (
  params: readonly unknown[] | undefined
): PositionalSqliteBinding[] => [...decodeSqliteParams(params ?? [])];

// Tagged error for every SQLite failure, so the Effect error channel stays typed
// (`SqliteError`) instead of the opaque global `Error` the language-service flags.
// `Data.TaggedError` instances still extend the global `Error`, so an
// `Effect<Value, SqliteError>` remains assignable to the `Effect<Value, Error>`
// the store's `runEffect` bridge expects; the original cause is preserved.
class SqliteError extends Data.TaggedError("SqliteError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `SQLite operation failed: ${formatUnknownError(this.cause)}`;
  }
}

const toSqliteError = (cause: unknown): SqliteError =>
  new SqliteError({ cause });

const executeRaw = (
  database: DatabaseSync,
  sql: string
): Effect.Effect<StatementResultingChanges, SqliteError> =>
  Effect.try({
    catch: toSqliteError,
    try: () => database.prepare(sql).run(),
  });

const configureSqliteDatabase = Effect.fn(
  "SqliteStateStore.configureSqliteDatabase"
)(function* (database: DatabaseSync) {
  yield* executeRaw(database, JOURNAL_MODE_PRAGMA);
  yield* executeRaw(database, FOREIGN_KEYS_PRAGMA);
  yield* executeRaw(database, RESERVED_KV_TABLE_SQL);
});

const openSqliteDatabase = Effect.fn("SqliteStateStore.open")(function* (
  config: SqliteStateStoreConfig
) {
  const resolvedPath = resolve(config.path);
  yield* Effect.sync(() =>
    mkdirSync(dirname(resolvedPath), { recursive: true })
  );
  const database = yield* Effect.try({
    catch: toSqliteError,
    try: () => new DatabaseSync(resolvedPath),
  });
  yield* configureSqliteDatabase(database);
  return database;
});

const runStatement = (
  database: DatabaseSync,
  sql: string,
  params: readonly unknown[] | undefined
): Effect.Effect<StatementResultingChanges, SqliteError> =>
  Effect.try({
    catch: toSqliteError,
    try: () =>
      database.prepare(sql).run(...(bindParams(params) as SQLInputValue[])),
  });

const queryRows = <Row>(
  database: DatabaseSync,
  sql: string,
  params: readonly unknown[] | undefined
): Effect.Effect<readonly Row[], SqliteError> =>
  Effect.try({
    catch: toSqliteError,
    try: () => {
      const rows: unknown = database
        .prepare(sql)
        .all(...(bindParams(params) as SQLInputValue[]));
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- StateStore.query<Row> is intentionally caller-narrowed.
      return rows as readonly Row[];
    },
  });

export const makeSqliteStateStore = (
  config: SqliteStateStoreConfig,
  options: SqliteStateStoreOptions
): StateStore => {
  let database: DatabaseSync | undefined;
  const { runEffect } = options;

  const getDatabase = Effect.fn("SqliteStateStore.getDatabase")(function* () {
    if (database !== undefined) {
      return database;
    }

    database = yield* openSqliteDatabase(config);
    return database;
  });

  // Clear the closure slot so a later call re-opens rather than reusing a
  // closed connection. Closing the last connection lets SQLite checkpoint and
  // remove the WAL/SHM sidecars the `PRAGMA journal_mode = WAL` above creates.
  // There is no `throwOnError` option on node:sqlite's `close()`; it wraps
  // `sqlite3_close_v2()`, so teardown never throws on in-flight statements —
  // matching the "safe to call multiple times" contract.
  const closeDatabase = Effect.fn("SqliteStateStore.close")(function* () {
    const open = database;
    if (open === undefined) {
      return;
    }
    database = undefined;
    yield* Effect.try({
      catch: toSqliteError,
      try: () => {
        open.close();
      },
    });
  });

  return {
    close: () => runEffect(closeDatabase()),
    exec: (sql, params) =>
      runEffect(
        getDatabase().pipe(
          Effect.flatMap((db) => runStatement(db, sql, params)),
          Effect.asVoid
        )
      ),
    get: (key) =>
      runEffect(
        getDatabase().pipe(
          Effect.flatMap((db) => queryRows(db, READ_KV_SQL, [key])),
          Effect.flatMap((rows) => readKvValue(key, rows[0]))
        )
      ),
    name: SQLITE_STORE_NAME,
    query: (sql, params) =>
      runEffect(
        getDatabase().pipe(Effect.flatMap((db) => queryRows(db, sql, params)))
      ),
    set: (key, value) =>
      runEffect(
        getDatabase().pipe(
          Effect.flatMap((db) => runStatement(db, UPSERT_KV_SQL, [key, value])),
          Effect.asVoid
        )
      ),
  };
};

/**
 * Scoped constructor that ties the store's lifetime to the caller's Effect
 * `Scope`: the store is created on acquire and its `close` runs as a finalizer
 * on release, so the SQLite handle (and its WAL/SHM sidecars) is torn down
 * deterministically when the scope closes rather than waiting on GC. Use this
 * wherever the runtime already threads a `Scope` (daemon boot, schedule
 * runner); `makeSqliteStateStore` remains for callers that own the lifecycle
 * themselves.
 */
export const makeSqliteStateStoreScoped = (
  config: SqliteStateStoreConfig,
  options: SqliteStateStoreOptions
): Effect.Effect<StateStore, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => makeSqliteStateStore(config, options)),
    (store) =>
      store.close === undefined
        ? Effect.void
        : Effect.promise(() => store.close?.() ?? Promise.resolve())
  );

/**
 * The db-sqlite state store as a `Context.Service`. `BuiltInDbCatalog`
 * (`built-in-catalog/db.ts`) yields this tag; the live handle is supplied at the
 * composition root by `builtInSqliteStateStoreLayer`, which wraps the
 * `SqliteStateStoreLive` adapter (`sqlite-state-store-live.ts`).
 *
 * The service shape is the author {@link StateStore} contract itself — a bundle
 * of Promise-returning methods (`close?`/`exec`/`get`/`query`/`set`/`name`), the
 * author boundary being deliberately Effect-free — so no parallel interface is
 * declared for it.
 */
export class SqliteStateStore extends Context.Service<
  SqliteStateStore,
  StateStore
>()("routekit-eval/builtins/db-sqlite/SqliteStateStore") {
  /**
   * Test seam: an inert in-memory store — `query` returns empty, `get` returns
   * undefined, `exec`/`set`/`close` succeed — with per-field spread override.
   * The effectful store that opens a real node:sqlite handle lives in the
   * `SqliteStateStoreLive` adapter (`sqlite-state-store-live.ts`).
   */
  static readonly layerTest = (
    impl: Partial<StateStore>
  ): Layer.Layer<SqliteStateStore> =>
    Layer.succeed(SqliteStateStore)(
      SqliteStateStore.of({
        close: () => Promise.resolve(),
        exec: () => Promise.resolve(),
        get: () => Promise.resolve(missingStateValue),
        name: SQLITE_STORE_NAME,
        query: () => Promise.resolve([]),
        set: () => Promise.resolve(),
        ...impl,
      })
    );
}

export {
  SQLITE_STORE_NAME,
  SQLITE_STATE_FILE,
  readSqliteStateStoreConfig,
  readSqliteStateStoreConfigFromConfig,
  SqliteError,
};
export type { SqliteStateStoreConfig, SqliteStateStoreOptions };
