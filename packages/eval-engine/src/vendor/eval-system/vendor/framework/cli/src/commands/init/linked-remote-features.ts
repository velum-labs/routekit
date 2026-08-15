import { Effect, FileSystem, Path, Schema } from "effect";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { encodeJsonString } from "../../../../contracts/internal/src/json.ts";
import { resolveFeaturesRoot } from "../../../../runloop/local/src/feature-boot/services.ts";
import { readRouteKitEvalMdFeatureSources } from "../dev/routekit-eval-md-feature-sources.ts";
import { writeProgressNotice } from "../dev/progress-notice.ts";
import {
  isRemoteFeaturesInput,
  materializeRemoteFeaturesRoot,
  parseRemoteFeatureSourceEffect,
} from "../features/remote-feature-root.ts";
import { ROUTEKIT_EVAL_DIRECTORY_NAME } from "../../routekit-eval-directory.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

/**
 * Toolchain-side linking for `routekit-eval.md`-declared remote feature sources. The
 * runtime composes remote features at boot (`.routekit-eval/composed`), but npm and tsc
 * never see that root: a local feature declaring a `workspace:*` dependency on
 * a remote feature fails `npm install` before typecheck or tests run. This
 * module makes the declared remote features visible to the package manager:
 * each one is symlinked under `.routekit-eval/linked-features/<name>` and registered as
 * an explicit `workspaces` entry in the root package.json (npm resolves an
 * explicit entry even under a dot-directory, where a glob would not match).
 * Spec: docs/rfcs/0004-cli/features.md ("Toolchain resolution").
 */

const LINKED_FEATURES_DIR = "linked-features";
const FEATURES_DIR = "features";
const PACKAGE_JSON_FILE = "package.json";
const JSON_INDENT = 2;

const PackageJsonWorkspacesSchema = Schema.Struct({
  workspaces: Schema.optionalKey(Schema.Array(Schema.String)),
});
const decodeWorkspacesShapeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PackageJsonWorkspacesSchema)
);
const ManifestRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeManifestJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ManifestRecordSchema)
);

const linkedFeaturesEntry = (name: string): string =>
  `${ROUTEKIT_EVAL_DIRECTORY_NAME}/${LINKED_FEATURES_DIR}/${name}`;

const isLinkedFeaturesEntry = (entry: string): boolean =>
  entry.startsWith(`${ROUTEKIT_EVAL_DIRECTORY_NAME}/${LINKED_FEATURES_DIR}/`);

/**
 * Rewrite the root package.json `workspaces` so its managed
 * `.routekit-eval/linked-features/<name>` entries match `linkedNames` exactly, leaving
 * every other entry (and every other key) untouched. Idempotent: nothing is
 * written when the entries are already current.
 */
const syncWorkspaceEntries = Effect.fn("LinkedFeatures.syncWorkspaceEntries")(
  function* (projectRoot: string, linkedNames: readonly string[]) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageJsonPath = path.join(projectRoot, PACKAGE_JSON_FILE);
    const raw = yield* fs.readFileString(packageJsonPath);
    const shape = yield* decodeWorkspacesShapeJson(raw);
    const current = shape.workspaces ?? [];
    const kept = current.filter((entry) => !isLinkedFeaturesEntry(entry));
    const next = [
      ...kept,
      ...[...linkedNames].toSorted().map(linkedFeaturesEntry),
    ];
    const unchanged =
      next.length === current.length &&
      next.every((entry, index) => entry === current[index]);
    if (unchanged) {
      return;
    }
    const manifest = yield* decodeManifestJson(raw);
    const updated = {
      ...manifest,
      workspaces: next,
    };
    const serialized = yield* encodeJsonString(
      ManifestRecordSchema,
      JSON_INDENT
    )(updated);
    yield* fs.writeFileString(packageJsonPath, `${serialized}\n`);
  }
);

const localFeatureNames = Effect.fn("LinkedFeatures.localNames")(function* (
  projectRoot: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const localFeaturesDir = path.join(projectRoot, FEATURES_DIR);
  const entries = yield* fs
    .readDirectory(localFeaturesDir)
    .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
  const names = new Set<string>();
  for (const entry of entries) {
    const isDirectory = yield* fs.stat(path.join(localFeaturesDir, entry)).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false)
    );
    if (isDirectory) {
      names.add(entry);
    }
  }
  return names;
});

/** Feature directories under a materialized root that bun can adopt as workspace members. */
const packageFeatureDirs = Effect.fn("LinkedFeatures.packageFeatureDirs")(
  function* (featuresRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs
      .readDirectory(featuresRoot)
      .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
    const dirs = new Map<string, string>();
    for (const entry of [...entries].toSorted()) {
      const candidate = path.join(featuresRoot, entry);
      const hasManifest = yield* fs
        .exists(path.join(candidate, PACKAGE_JSON_FILE))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasManifest) {
        dirs.set(entry, candidate);
      }
    }
    return dirs;
  }
);

const materializeDeclaredSource = Effect.fn("LinkedFeatures.materializeSource")(
  function* (value: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = yield* parseRemoteFeatureSourceEffect(value);
    if (source === undefined) {
      return;
    }
    const root = yield* materializeRemoteFeaturesRoot(source).pipe(
      Effect.mapError((error) =>
        Schema.is(CliFailureError)(error)
          ? error
          : new CliFailureError({ detail: formatUnknownError(error) })
      )
    );
    // Same nested-`features/` resolution local roots get: the repo root may hold
    // the features under a `features/` subdirectory.
    return yield* resolveFeaturesRoot(fs, path, root).pipe(
      Effect.orElseSucceed(() => path.resolve(root))
    );
  }
);

const rebuildLinkedFeaturesDir = Effect.fn("LinkedFeatures.rebuildDir")(
  function* (linkedDir: string, targets: ReadonlyMap<string, string>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(linkedDir, {
      force: true,
      recursive: true,
    });
    if (targets.size === 0) {
      return;
    }
    yield* fs.makeDirectory(linkedDir, { recursive: true });
    for (const [name, target] of targets) {
      yield* fs.symlink(target, path.join(linkedDir, name));
    }
  }
);

/**
 * Materialize every remote source declared in the workspace's `routekit-eval.md`
 * `features:` list (branch-tip cache: each run refreshes a branch ref to its
 * tip, falling back to the cached copy offline), link the resulting feature
 * directories under `.routekit-eval/linked-features/`, and register them as workspace
 * members so `npm install`, tsc, and `node --test` resolve them. A local
 * `features/<name>` always shadows a declared remote feature of the same
 * name; among declared sources the last one wins, mirroring the runtime
 * composition order.
 */
export const linkDeclaredRemoteFeatures = Effect.fn(
  "LinkedFeatures.linkDeclared"
)(function* (projectRoot: string) {
  const path = yield* Path.Path;
  const cliIo = yield* CliIo;
  const declared = yield* readRouteKitEvalMdFeatureSources(projectRoot);
  const remoteSources = declared.filter(isRemoteFeaturesInput);
  const linkedDir = path.join(
    projectRoot,
    ROUTEKIT_EVAL_DIRECTORY_NAME,
    LINKED_FEATURES_DIR
  );
  if (remoteSources.length === 0) {
    yield* rebuildLinkedFeaturesDir(linkedDir, new Map());
    yield* syncWorkspaceEntries(projectRoot, []);
    return [];
  }

  const localNames = yield* localFeatureNames(projectRoot);
  const targets = new Map<string, string>();
  for (const value of remoteSources) {
    const featuresRoot = yield* materializeDeclaredSource(value);
    if (featuresRoot === undefined) {
      continue;
    }
    const dirs = yield* packageFeatureDirs(featuresRoot);
    for (const [name, target] of dirs) {
      if (localNames.has(name)) {
        yield* cliIo
          .writeStderr(
            `routekit-eval init: local feature "${name}" shadows the one declared from ${value}.\n`
          )
          .pipe(Effect.ignore);
        continue;
      }
      targets.set(name, target);
    }
  }

  yield* rebuildLinkedFeaturesDir(linkedDir, targets);
  yield* syncWorkspaceEntries(projectRoot, [...targets.keys()]);
  const linked = [...targets.keys()].toSorted();
  if (linked.length > 0) {
    yield* writeProgressNotice(
      `Linked ${linked.length} remote feature${linked.length === 1 ? "" : "s"} (${linked.join(", ")}) into ${ROUTEKIT_EVAL_DIRECTORY_NAME}/${LINKED_FEATURES_DIR}/.\n`
    ).pipe(Effect.ignore);
  }
  return linked;
});

export { isLinkedFeaturesEntry, linkedFeaturesEntry };
