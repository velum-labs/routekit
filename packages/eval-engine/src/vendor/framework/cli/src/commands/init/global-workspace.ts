import type { PlatformError } from "effect/PlatformError";

import { Cause, Effect, FileSystem, Option, Path } from "effect";
import { zipSync } from "fflate";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { ensureDevWorkspaceDependencies } from "../dev/dependencies.ts";
import { writeProgressNotice } from "../dev/progress-notice.ts";
import { initProject } from "./init.ts";
import { DEFAULT_TEMPLATE } from "./template-source.ts";
import { isExistingDirectory } from "../../fs-directory.ts";
import {
  resolveGlobalFeaturesRoot,
  resolveGlobalWorkspaceRoot,
} from "../../ori-directory.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const FEATURES_DIR = "features";
const BACKUPS_DIR = "backups";

/**
 * Regenerated on install, and large. A workspace carries one of these at the
 * root and another inside every feature that declares dependencies, so this has
 * to match at any depth, not just the top level.
 */
const EXCLUDED_ANYWHERE = new Set(["node_modules"]);

const ORI_DIR = ".ori";

/**
 * The `.ori/` entries a boot or an install rebuilds. Left in, they dominate the
 * archive (on a plain workspace `docs`, `snapshot`, `sdk` and `lint` are most of
 * the file count, and `remote-features` clones whole repos), and every byte is
 * held in memory while the zip is built.
 *
 * Anything under `.ori/` that is NOT listed here is kept on purpose. The author
 * store (`state.sqlite`) lives there and holds data a feature persisted, so the
 * failure modes are not symmetric: archiving a cache we could have skipped is
 * wasted space, dropping a file a user cannot regenerate is gone for good.
 */
const GENERATED_ORI_ENTRIES = new Set([
  "docs",
  "feature-apis.d.ts",
  "feature-hooks.d.ts",
  "linked-features",
  "lint",
  "logs",
  "materialized-skills.json",
  "remote-features",
  "sdk",
  "snapshot",
]);

/** Where a workspace archive lands: `~/.ori/backups/global-<timestamp>.zip`. */
export const globalWorkspaceBackupPath = (
  globalRoot: string,
  path: Path.Path,
  timestampMillis: number
): string => {
  const timestamp = new Date(timestampMillis)
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  return path.join(
    path.dirname(globalRoot),
    BACKUPS_DIR,
    `global-${timestamp}.zip`
  );
};

const isArchivable = (segments: readonly string[]): boolean => {
  if (segments.some((segment) => EXCLUDED_ANYWHERE.has(segment))) {
    return false;
  }
  const [top, next] = segments;
  return !(
    top === ORI_DIR &&
    next !== undefined &&
    GENERATED_ORI_ENTRIES.has(next)
  );
};

/**
 * `stat` follows symlinks, so a dangling one throws. A real global workspace
 * chains `.claude/skills/*` and `.agents/skills/*` through `.ori/snapshot/current`,
 * and pruning one snapshot generation dangles all of them at once, so refusing to
 * archive such a workspace would strand exactly the workspaces most in need of a
 * copy. A broken link carries no bytes, so it is skipped.
 *
 * Every other stat failure propagates. A caller deletes the workspace once this
 * succeeds, so a file that exists but cannot be read right now (a permission
 * blip, a racing writer) must fail the archive rather than vanish from it.
 */
const statArchivable = (
  fs: FileSystem.FileSystem,
  source: string
): Effect.Effect<Option.Option<FileSystem.File.Info>, PlatformError> =>
  fs.stat(source).pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone
    )
  );

const collectWorkspaceFiles = Effect.fn("GlobalWorkspace.collectFiles")(
  function* (globalRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(globalRoot, { recursive: true });
    const files: Record<string, Uint8Array> = {};
    for (const entry of entries) {
      const segments = entry.split(path.sep);
      if (!isArchivable(segments)) {
        continue;
      }
      const source = path.join(globalRoot, entry);
      const info = yield* statArchivable(fs, source);
      if (Option.isNone(info) || info.value.type !== "File") {
        continue;
      }
      files[segments.join("/")] = yield* fs.readFile(source);
    }
    return files;
  }
);

/**
 * Stage the archive beside its destination and rename it into place, so
 * `backupPath` only ever exists as a complete archive. A caller treats this
 * path existing as "the workspace is recoverable" before it deletes anything,
 * and a half-written zip left by a disk-full or an EIO would answer that
 * question wrong. The rename is atomic within a directory; the staging file is
 * removed on any failure so a retry does not trip over it.
 */
const writeWorkspaceArchive = Effect.fn("GlobalWorkspace.writeArchive")(
  function* (globalRoot: string, backupPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(backupPath), { recursive: true });
    const files = yield* collectWorkspaceFiles(globalRoot);
    const staging = `${backupPath}.partial`;
    yield* Effect.onError(
      Effect.gen(function* () {
        yield* fs.writeFile(staging, zipSync(files));
        yield* fs.rename(staging, backupPath);
      }),
      () => Effect.ignore(fs.remove(staging))
    );
  }
);

/**
 * Archive the global workspace to `backupPath`, keeping everything a user
 * authored and dropping what an install regenerates. Reads only: this never
 * deletes or moves anything, so a caller can treat a success as "the workspace
 * is now recoverable" before it does something destructive.
 */
export const createGlobalWorkspaceBackup = (
  globalRoot: string,
  backupPath: string
): Effect.Effect<void, CliFailureError, FileSystem.FileSystem | Path.Path> =>
  writeWorkspaceArchive(globalRoot, backupPath).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(
        new CliFailureError({
          cause,
          detail: `Could not archive the global workspace to ${backupPath}: ${formatUnknownError(Cause.squash(cause))}`,
          hint: `${globalRoot} was left untouched.`,
        })
      )
    )
  );

/**
 * Whether `ori dev`/`ori start` should scaffold the global workspace before
 * falling back to it: only when no explicit `--features` was given and neither
 * the current directory nor an existing global workspace has a `features/`.
 */
const shouldScaffoldGlobalWorkspace = (input: {
  readonly cwdHasFeatures: boolean;
  readonly globalHasFeatures: boolean;
  readonly hasExplicitFeatures: boolean;
}): boolean =>
  !(
    input.hasExplicitFeatures ||
    input.cwdHasFeatures ||
    input.globalHasFeatures
  );

// The credential gate is suppressed because every caller is already running and
// does its own authoritative credential check, so a second login prompt would be
// redundant.
const scaffoldGlobalWorkspace = Effect.fn("GlobalWorkspace.scaffold")(
  function* (globalRoot: string) {
    const path = yield* Path.Path;
    yield* initProject({
      cwd: path.dirname(globalRoot),
      failOnInstallError: true,
      global: true,
      install: true,
      name: path.basename(globalRoot),
      skipCredentialGate: true,
      suppressNextSteps: true,
      template: DEFAULT_TEMPLATE,
    });
  }
);

const ensureGlobalWorkspaceDependencies = Effect.fn(
  "GlobalWorkspace.ensureDependencies"
)(function* (globalRoot: string, globalFeaturesRoot: string, install: boolean) {
  if (!install) {
    return;
  }

  const cliIo = yield* CliIo;
  yield* ensureDevWorkspaceDependencies({
    featuresRoot: globalFeaturesRoot,
    install: true,
    workspaceRoot: globalRoot,
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        cliIo.writeStderr(
          `Could not refresh global workspace dependencies in ${globalRoot}: ${formatUnknownError(error)}\n`
        ),
      onSuccess: () => Effect.void,
    })
  );
});

/**
 * Scaffold `~/.ori/global` on demand so `ori dev`/`ori start` always have a
 * workspace to fall back to when the working directory has no `features/`.
 * No-op when `--features` was passed, the cwd is already a workspace, or the
 * global workspace is healthy, so existing projects are never touched.
 */
export const ensureGlobalWorkspaceFallback = Effect.fn(
  "GlobalWorkspace.ensureFallback"
)(function* (features: Option.Option<string>, install?: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const globalRoot = yield* resolveGlobalWorkspaceRoot();

  const cwdHasFeatures = yield* isExistingDirectory(
    fs,
    path.join(path.resolve(), FEATURES_DIR)
  );
  const globalHasFeatures = yield* isExistingDirectory(
    fs,
    path.join(globalRoot, FEATURES_DIR)
  );
  const scaffold = shouldScaffoldGlobalWorkspace({
    cwdHasFeatures,
    globalHasFeatures,
    hasExplicitFeatures: Option.isSome(features),
  });
  if (!scaffold) {
    if (!Option.isSome(features) && !cwdHasFeatures && globalHasFeatures) {
      yield* ensureGlobalWorkspaceDependencies(
        globalRoot,
        path.join(globalRoot, FEATURES_DIR),
        install ?? true
      );
    }
    return;
  }

  yield* writeProgressNotice(
    `No features/ in the current directory and no global workspace yet; creating one at ${globalRoot}...\n`
  );
  yield* scaffoldGlobalWorkspace(globalRoot);
  yield* writeProgressNotice(`Global workspace ready at ${globalRoot}.\n`);
});

/**
 * Ensure the global workspace exists and return its `features/` root.
 *
 * `ori code` always boots against `~/.ori/global/features` (never the launch
 * directory's own `features/`), so — unlike {@link ensureGlobalWorkspaceFallback}
 * — this scaffolds purely on "the global workspace is missing", independent of
 * what the current directory contains. Idempotent: an existing global workspace
 * is left in place while its dependencies are checked and repaired when needed.
 */
export const ensureGlobalWorkspaceForCode = Effect.fn(
  "GlobalWorkspace.ensureForCode"
)(function* (install?: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const globalRoot = yield* resolveGlobalWorkspaceRoot();
  const globalFeaturesRoot = yield* resolveGlobalFeaturesRoot();

  if (yield* isExistingDirectory(fs, globalFeaturesRoot)) {
    yield* ensureGlobalWorkspaceDependencies(
      globalRoot,
      globalFeaturesRoot,
      install ?? true
    );
    return globalFeaturesRoot;
  }

  yield* writeProgressNotice(
    `No global Ori workspace yet; creating one at ${globalRoot}...\n`
  );
  yield* scaffoldGlobalWorkspace(globalRoot);
  yield* writeProgressNotice(`Global workspace ready at ${globalRoot}.\n`);
  return globalFeaturesRoot;
});

/**
 * Archive the global workspace, delete it, and scaffold a fresh one from the
 * template. The archive is the entire safety story here: it runs first and a
 * failure aborts before anything is removed, so the workspace is either intact
 * or recoverable from `backupPath`, never neither.
 *
 * The caller owns consent. This does not ask.
 */
export const resetGlobalWorkspace = Effect.fn("GlobalWorkspace.reset")(
  function* (backupPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const globalRoot = yield* resolveGlobalWorkspaceRoot();
    yield* createGlobalWorkspaceBackup(globalRoot, backupPath);
    yield* fs.remove(globalRoot, { recursive: true });
    yield* scaffoldGlobalWorkspace(globalRoot);
    return globalRoot;
  }
);

export { shouldScaffoldGlobalWorkspace };
