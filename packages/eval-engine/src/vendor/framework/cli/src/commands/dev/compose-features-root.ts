import { Effect, FileSystem, Option, Path } from "effect";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { ROOT_PERSONA_FILE } from "../../../../runloop/local/src/contributions/root-persona.ts";
import { resolveFeaturesRoot } from "../../../../runloop/local/src/feature-boot/services.ts";
import { resolveFeaturesRootInput } from "../features/remote-feature-root.ts";
import { isExistingDirectory } from "../../fs-directory.ts";
import {
  ORI_DIRECTORY_NAME,
  OriDirectory,
} from "../../ori-directory.ts";

const FEATURES_DIR = "features";
// The composed root lives under the workspace's own (gitignored) `.ori/`, beside
// the remote-features cache, so nothing is written into the user's `features/`.
const COMPOSED_ROOT_DIR = "composed";
// Staging suffix for the atomic build: assemble the composed tree fully, then
// rename it into place so a running boot never sees a half-built root.
const SWAP_SUFFIX = ".swap";

/**
 * True when `featuresRoot` is (or lives under) a materialized `.ori/composed`
 * root. A composed root is an internal artifact: it links each source's
 * `features/` plus the declaring workspace's `ori.md`. Callers that re-resolve a
 * features root (notably `ori start`, which hands its already-composed root back
 * to `prepareDevFeaturesRoot`) MUST NOT treat it as a fresh source — re-reading
 * its linked `ori.md` `features:` and composing again would resolve declared
 * paths against `.ori/composed` and crash. This predicate lets them short-circuit.
 *
 * Matches the `.ori` → `composed` pair on path-segment boundaries (splitting on
 * both `/` and `\`), not as a raw substring, so a user feature dir that merely
 * contains those characters — or a Windows-separator path — never false-matches.
 */
export const isComposedFeaturesRoot = (featuresRoot: string): boolean => {
  const segments = featuresRoot.split(/[/\\]/u);
  return segments.some(
    (segment, index) =>
      segment === ORI_DIRECTORY_NAME &&
      segments[index + 1] === COMPOSED_ROOT_DIR
  );
};

/**
 * A resolved features source: its origin string (as the user passed it) and the
 * absolute local features directory it resolved to (a local dir, or the remote
 * cache dir that stands in for a `github.com/...` path).
 */
interface ResolvedSource {
  readonly origin: string;
  readonly root: string;
}

/** Resolve one `--features` value to a local features directory. */
const resolveSource = Effect.fn("ComposeFeatures.resolveSource")(function* (
  value: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Remote repo paths materialize into the `.ori/remote-features` cache; local
  // values pass through. Then apply the same nested-`features/` resolution a
  // single `--features` gets, so a passed workspace root resolves to its
  // `features/` child.
  const input = yield* resolveFeaturesRootInput(value);
  const resolved = yield* resolveFeaturesRoot(fs, path, input).pipe(
    Effect.orElseSucceed(() => path.resolve(input))
  );
  if (!(yield* isExistingDirectory(fs, resolved))) {
    return yield* new CliFailureError({
      detail: `Features directory not found for --features ${value} (resolved to ${resolved}).`,
    });
  }
  return {
    origin: value,
    root: resolved,
  } satisfies ResolvedSource;
});

/** The immediate subdirectory names of a features root (the feature ids), sorted. */
const featureDirNames = Effect.fn("ComposeFeatures.featureDirNames")(function* (
  root: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(root)
    .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
  const names: string[] = [];
  for (const entry of [...entries].toSorted()) {
    const isDir = yield* fs.stat(path.join(root, entry)).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false)
    );
    if (isDir) {
      names.push(entry);
    }
  }
  return names;
});

/**
 * The base `.ori/composed` directory to materialize the composed root under: the
 * enclosing workspace's `.ori/` when inside a workspace, else `~/.ori`. Mirrors
 * the remote-features cache location so both live in the same gitignored spot.
 */
const composedBaseDir = Effect.fn("ComposeFeatures.baseDir")(function* () {
  const path = yield* Path.Path;
  const hostProcess = yield* HostProcess;
  const oriDirectory = yield* OriDirectory;
  const cwd = yield* hostProcess.currentWorkingDirectory;
  const workspaceRoot = yield* oriDirectory.workspaceRootFrom(cwd);
  const base = Option.isSome(workspaceRoot)
    ? path.join(workspaceRoot.value, ORI_DIRECTORY_NAME)
    : path.join(yield* hostProcess.homeDirectory, ORI_DIRECTORY_NAME);
  return path.join(base, COMPOSED_ROOT_DIR);
});

/**
 * Symlink every feature subdirectory from each source into `featuresDir`. Later
 * sources shadow earlier ones on a name collision (last `--features` wins),
 * emitting a one-line stderr notice per shadow.
 */
const linkFeatures = Effect.fn("ComposeFeatures.linkFeatures")(function* (
  featuresDir: string,
  sources: readonly ResolvedSource[]
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliIo = yield* CliIo;
  const owner = new Map<string, string>();
  for (const source of sources) {
    const names = yield* featureDirNames(source.root);
    for (const name of names) {
      const linkPath = path.join(featuresDir, name);
      const previous = owner.get(name);
      if (previous !== undefined) {
        yield* fs.remove(linkPath, { force: true }).pipe(Effect.ignore);
        yield* cliIo
          .writeStderr(
            `ori start: feature "${name}" from ${source.origin} shadows the one from ${previous}.\n`
          )
          .pipe(Effect.ignore);
      }
      yield* fs.symlink(path.join(source.root, name), linkPath);
      owner.set(name, source.origin);
    }
  }
});

/**
 * Link the declaring workspace's root persona `ori.md` into the composed root,
 * beside its `features/`, when it has one. The turn-time boot resolves the root
 * persona from `dirname(featuresRoot)` (RFC 0002 root-persona.md), which for a
 * composed root is `.ori/composed` — not any real workspace — so without this
 * the intern's declared model, harness preference, and persona body silently
 * vanish whenever ≥2 sources are composed.
 *
 * The persona owner is the anchor workspace: the project whose `ori.md`
 * `features:` declared the sources when driven that way (independent of source
 * order, so a declared source's persona never shadows the declaring project),
 * else the first `--features` source's workspace for a pure `ori start
 * --features …` run. It is a single workspace-level entry (last-shadow-wins over
 * the built-in default), not a per-source contribution; a declared or
 * `--features` source that wants to set the model does so through a
 * `features/model` feature, which composes in like any other feature.
 * `composedDir` is the `.swap` staging dir, symmetric with {@link linkFeatures}.
 */
const linkRootPersona = Effect.fn("ComposeFeatures.linkRootPersona")(function* (
  composedDir: string,
  personaWorkspaceRoot: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const personaPath = path.join(personaWorkspaceRoot, ROOT_PERSONA_FILE);
  const present = yield* fs
    .exists(personaPath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!present) {
    return;
  }
  yield* fs.symlink(personaPath, path.join(composedDir, ROOT_PERSONA_FILE));
});

/**
 * Materialize the composed root at `composedDir` from `sources`: stage the whole
 * tree (a symlink per feature, plus the declaring workspace's `ori.md`) in a
 * sibling `.swap` dir, then rename it over the destination so a concurrent or
 * previous boot never observes a half-built root. Rebuilt every run, like the
 * remote cache, so a stale composition can't linger.
 */
const buildComposedRoot = Effect.fn("ComposeFeatures.buildComposedRoot")(
  function* (input: {
    readonly composedDir: string;
    readonly swapDir: string;
    readonly swapFeaturesDir: string;
    readonly sources: readonly ResolvedSource[];
    readonly personaWorkspaceRoot: string | undefined;
  }) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .remove(input.swapDir, {
        force: true,
        recursive: true,
      })
      .pipe(Effect.ignore);
    yield* fs.makeDirectory(input.swapFeaturesDir, { recursive: true });
    yield* linkFeatures(input.swapFeaturesDir, input.sources);
    // Stage the declaring workspace's `ori.md` beside the composed `features/` so
    // the turn-time boot's `dirname(featuresRoot)` persona lookup finds it.
    if (input.personaWorkspaceRoot !== undefined) {
      yield* linkRootPersona(input.swapDir, input.personaWorkspaceRoot);
    }
    yield* fs
      .remove(input.composedDir, {
        force: true,
        recursive: true,
      })
      .pipe(Effect.ignore);
    yield* fs.rename(input.swapDir, input.composedDir);
  }
);

/**
 * The result of composing `--features` sources: the features root the intern
 * boots from, and the workspace root that anchors credentials, config, the dev
 * descriptor, and durable state.
 */
export interface ComposedFeatures {
  readonly featuresRoot: string;
  /**
   * The real workspace root — what anchors credentials, config, the dev
   * descriptor, and durable state. Precedence: an explicit `anchorWorkspaceRoot`
   * option when given (used when `ori.md`'s own project must anchor, regardless
   * of source order); else the FIRST source's workspace root for a composed
   * root; else `dirname(featuresRoot)` for a single source. Never
   * `dirname(<.ori>/composed/features)`, which would point resolution at the
   * cache dir.
   */
  readonly workspaceRoot: string;
  /**
   * True only when ≥2 sources were consolidated into a `.ori/composed` root.
   * The caller uses this to decide whether to override the downstream workspace
   * root; for a single source (`false`) it leaves the existing derivation alone
   * so that path stays byte-for-byte unchanged.
   */
  readonly composed: boolean;
}

/** Options for {@link composeFeatureRoots}. */
export interface ComposeFeatureRootsOptions {
  /**
   * The workspace root to anchor credentials/config/descriptor/state to,
   * overriding the positional derivation. Set this when the sources were driven
   * by a workspace's `ori.md` `features:` (the declaring project must anchor)
   * so the anchor is independent of the shadow order — the local `./features`
   * can be ordered last to win name clashes while its project still anchors.
   */
  readonly anchorWorkspaceRoot?: string | undefined;
}

/**
 * Consolidate multiple `--features` sources (local dirs and/or remote repo
 * paths) into one features root the intern boots from, so `bun features/<name>/…`
 * invocations resolve regardless of a feature's origin.
 *
 * - 0 inputs → `undefined` (caller uses its default `./features` resolution).
 * - 1 input → that source's resolved root directly (byte-for-byte the single
 *   `--features` behaviour; no composed directory is created).
 * - ≥2 inputs → a composed root at `<.ori>/composed/features` containing a
 *   symlink per feature from every source (later sources win on name clashes).
 *   Built atomically (stage in a sibling `.swap` dir, then rename over the
 *   destination) and rebuilt each run, like the remote cache.
 *
 * Returns the resolved features root plus the true workspace root (see
 * {@link ComposedFeatures}), or `undefined` when there are no inputs.
 */
export const composeFeatureRoots = Effect.fn("ComposeFeatures.compose")(
  function* (
    inputs: readonly string[],
    options: ComposeFeatureRootsOptions = {}
  ) {
    const [first] = inputs;
    if (first === undefined) {
      return;
    }
    const path = yield* Path.Path;
    // Single source: preserve today's exact path — resolve and return it, with
    // no composed dir and no symlinks. Workspace root is the explicit anchor when
    // given, else its parent, as before.
    if (inputs.length === 1) {
      const single = yield* resolveSource(first);
      return {
        composed: false,
        featuresRoot: single.root,
        workspaceRoot: options.anchorWorkspaceRoot ?? path.dirname(single.root),
      };
    }

    const sources: ResolvedSource[] = [];
    for (const value of inputs) {
      sources.push(yield* resolveSource(value));
    }

    const composedDir = yield* composedBaseDir();
    const swapDir = `${composedDir}${SWAP_SUFFIX}`;
    const featuresDir = path.join(composedDir, FEATURES_DIR);
    const swapFeaturesDir = path.join(swapDir, FEATURES_DIR);

    // The composed features root lives under `.ori/composed`, so its own parent
    // is NOT a real workspace. Anchor to the explicit workspace root when given
    // (e.g. the project whose `ori.md` declared the sources); else the FIRST
    // source's workspace root (the primary project). Never `.ori/composed`.
    const [firstSource] = sources;
    const positionalWorkspaceRoot =
      firstSource === undefined
        ? path.dirname(featuresDir)
        : path.dirname(firstSource.root);
    const workspaceRoot =
      options.anchorWorkspaceRoot ?? positionalWorkspaceRoot;

    yield* buildComposedRoot({
      composedDir,
      // The persona follows the anchor, not the shadow order: the declaring
      // workspace owns `ori.md`, so a declared/remote source ordered first never
      // shadows the declaring project's model/harness/persona.
      personaWorkspaceRoot: workspaceRoot,
      sources,
      swapDir,
      swapFeaturesDir,
    });

    return {
      composed: true,
      featuresRoot: featuresDir,
      workspaceRoot,
    };
  }
);
