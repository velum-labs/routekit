import { Context, Effect, Layer, Path } from "effect";

import type { StateStoreContribution } from "../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import type { NamedContributionEntry } from "../../../engine/registries/src/capability-entries.ts";
import type { ImportedContribution } from "../../local/src/contributions/imported-contribution.ts";

import {
  readSqliteStateStoreConfigFromConfig,
  SqliteStateStore,
} from "../../../builtins/db-sqlite/src/sqlite-state-store.ts";
import { SqliteStateStoreLive } from "../../../builtins/db-sqlite/src/sqlite-state-store-live.ts";
import { HostProcess } from "../../../contracts/internal/src/cli/host-process.ts";
import { ORI_INTERN_WORKSPACE_ROOT_ENV } from "../../../contracts/internal/src/cli/intern-launcher-env.ts";

const BUILT_IN_DB_KIND = "db";
const SQLITE_DB_FEATURE_ID = "@ori-builtins/db-sqlite";
const SQLITE_DB_NAME = "sqlite";

const nonEmptyWorkspaceRoot = (
  value: string | undefined
): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

type BuiltInDbContribution = ImportedContribution<
  NamedContributionEntry<StateStoreContribution>
>;

interface BuiltInDbCatalogShape {
  readonly defaultDbName: string;
  readonly dbs: readonly BuiltInDbContribution[];
}

const makeBuiltInDbContribution = (
  featureId: string,
  store: StateStoreContribution
): BuiltInDbContribution => ({
  entry: {
    featureId,
    name: store.name,
    value: store,
  },
  featureId,
  kind: BUILT_IN_DB_KIND,
  origin: "builtIn",
  shadows: false,
  sourcePath: `${featureId}/feature.ts`,
});

export class BuiltInDbCatalog extends Context.Service<
  BuiltInDbCatalog,
  BuiltInDbCatalogShape
>()("ori/runtime/BuiltInDbCatalog") {
  // Consumes the `SqliteStateStore` port and leaves it in `RIn` so tests can
  // inject `SqliteStateStore.layerTest`; the config-bound live handle is supplied
  // at the composition root by `builtInSqliteStateStoreLayer`.
  static readonly layer = Layer.effect(BuiltInDbCatalog)(
    Effect.gen(function* () {
      const sqliteStore = yield* SqliteStateStore;
      return BuiltInDbCatalog.of({
        dbs: [makeBuiltInDbContribution(SQLITE_DB_FEATURE_ID, sqliteStore)],
        defaultDbName: SQLITE_DB_NAME,
      });
    })
  );
}

/**
 * Config-bound live provider for {@link SqliteStateStore}. Resolves the default
 * `.ori/state.sqlite` path against the workspace root rather than the process
 * CWD: under systemd (or any launcher whose `WorkingDirectory` differs from the
 * workspace) `path.resolve()` would scatter state into the wrong directory. The
 * intern launcher and the dev/start CLI export the workspace root via
 * `ORI_INTERN_WORKSPACE_ROOT`; fall back to CWD when it is absent. `ORI_SQLITE_PATH`
 * / `ORI_STATE_DIR` still take precedence (resolved inside
 * `readSqliteStateStoreConfigFromConfig`). `Layer.unwrap` because the sqlite path
 * is a runtime binding, not a static `Config`.
 */
export const builtInSqliteStateStoreLayer = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const env = yield* (yield* HostProcess).env;
    const baseDir =
      nonEmptyWorkspaceRoot(env[ORI_INTERN_WORKSPACE_ROOT_ENV]) ??
      path.resolve();
    const config = yield* readSqliteStateStoreConfigFromConfig(baseDir);
    return SqliteStateStoreLive(config);
  })
);

export type { BuiltInDbCatalogShape };
