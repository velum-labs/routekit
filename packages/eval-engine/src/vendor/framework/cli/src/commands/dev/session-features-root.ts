import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { ORI_INTERN_WORKSPACE_ROOT_ENV } from "../../../../contracts/internal/src/cli/intern-launcher-env.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { workspaceRootFromFeaturesRoot } from "../../../../runloop/local/src/dev/descriptor.ts";
import { resolveFeaturesRoot } from "../../../../runloop/local/src/feature-boot/services.ts";
import {
  composeFeatureRoots,
  isComposedFeaturesRoot,
} from "./compose-features-root.ts";
import {
  ensureDevWorkspaceDependencies,
  restartAfterDevDependencyInstall,
} from "./dependencies.ts";
import { readOriMdFeatureSources } from "./ori-md-feature-sources.ts";
import {
  isRemoteFeaturesInput,
  resolveFeaturesRootInput,
} from "../features/remote-feature-root.ts";
import { ensureAuthorContractsCurrent } from "../init/author-contracts.ts";
import { isExistingDirectory } from "../../fs-directory.ts";
import {
  resolveGlobalFeaturesRoot,
  resolveGlobalWorkspaceRoot,
} from "../../ori-directory.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const FEATURES_DIR = "features";

/** Cap how many nearby workspaces we name in the "did you mean" hint. */
const MAX_NEARBY_WORKSPACE_HINTS = 5;

const shouldAnnounceGlobalFallback = (input: {
  readonly cwd: string;
  readonly hasExplicitFeatures: boolean;
  readonly isGlobalWorkspace: boolean;
  readonly workspaceRoot: string;
}): boolean =>
  input.isGlobalWorkspace &&
  !input.hasExplicitFeatures &&
  input.cwd !== input.workspaceRoot &&
  !input.cwd.startsWith(`${input.workspaceRoot}/`);

/**
 * Build a "did you mean a subdirectory" hint for the missing-features error.
 * `ori init` scaffolds a new project into a child directory named after the
 * workspace, so users frequently run `ori dev` from the parent and hit the
 * not-found error while a ready project sits one level down. Surface those
 * child workspaces (any immediate subdirectory that holds a features/ dir)
 * so the fix is an obvious `cd`, not a guess.
 */
const nearbyWorkspaceHint = Effect.fn("DevCommand.nearbyWorkspaceHint")(
  function* (fs: FileSystem.FileSystem, path: Path.Path, baseDir: string) {
    const entries = yield* fs
      .readDirectory(baseDir)
      .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
    const workspaces: string[] = [];
    for (const entry of [...entries].toSorted()) {
      const candidate = path.join(baseDir, entry, FEATURES_DIR);
      const isWorkspace = yield* fs.stat(candidate).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false)
      );
      if (isWorkspace) {
        workspaces.push(entry);
      }
    }
    if (workspaces.length === 0) {
      return "";
    }
    const named = workspaces.slice(0, MAX_NEARBY_WORKSPACE_HINTS);
    const listed = named.map((name) => `${name}/`).join(", ");
    const more = workspaces.length > named.length ? ", ..." : "";
    return ` A project with a features/ directory is right below you (${listed}${more}); did you mean to \`cd ${workspaces[0]}\` first?`;
  }
);

const currentWorkingDirectory = Effect.fn("DevCommand.cwd")(function* () {
  const path = yield* Path.Path;
  return path.resolve();
});

/**
 * The resolved feature root plus the workspace root that anchors credentials,
 * config, the dev descriptor, and durable state. `workspaceRoot` is the real
 * project (never `.ori/composed`); {@link workspaceOverride} is set only when a
 * composed root was materialized, so callers know to override the downstream
 * `dirname(featuresRoot)` derivation.
 */
export interface ResolvedDevFeatures {
  readonly featuresRoot: string;
  readonly workspaceRoot: string;
  /** Set to `workspaceRoot` only when a `.ori/composed` root was materialized. */
  readonly workspaceOverride?: string;
}

/**
 * Resolve the single local feature root from `--features` (or `./features`) and
 * fail fast when it does not exist — without this guard a missing root boots
 * silently with zero features and materializes built-in skill symlinks into
 * whatever directory the shell is in. With no `--features` and a non-workspace
 * cwd, fall back to the global workspace at `~/.ori/global/features`.
 */
const resolveLocalFeaturesRoot = Effect.fn("DevCommand.localFeaturesRoot")(
  function* (features: Option.Option<string>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const override = Option.getOrUndefined(features);
    // A remote repo path (`github.com/<owner>/<repo>[/path][@ref]`) materializes
    // into the `.ori/remote-features` cache and its local directory stands in.
    const input =
      override === undefined
        ? `${yield* currentWorkingDirectory()}/${FEATURES_DIR}`
        : yield* resolveFeaturesRootInput(override);
    // A failed nested-features probe (e.g. ENOTDIR when the input is a file)
    // falls through to the directory check below, which owns the user-facing error.
    const resolved = yield* resolveFeaturesRoot(fs, path, input).pipe(
      Effect.orElseSucceed(() => path.resolve(input))
    );
    if (yield* isExistingDirectory(fs, resolved)) {
      return resolved;
    }

    if (Option.isNone(features)) {
      const globalFeaturesRoot = yield* resolveGlobalFeaturesRoot();
      if (yield* isExistingDirectory(fs, globalFeaturesRoot)) {
        return globalFeaturesRoot;
      }
      const hint = yield* nearbyWorkspaceHint(fs, path, path.dirname(resolved));
      return yield* new CliFailureError({
        detail: `Features directory not found at ${resolved}, and no global workspace exists at ${path.dirname(globalFeaturesRoot)}. Run \`ori dev\` from a project root that contains a features/ directory, pass --features <dir>, or run \`ori init --global\` to create a global workspace.${hint}`,
      });
    }

    const hint = yield* nearbyWorkspaceHint(fs, path, path.dirname(resolved));
    return yield* new CliFailureError({
      detail: `Features directory not found at ${resolved}. Run \`ori dev\` from a project root that contains a features/ directory, or pass --features <dir>.${hint}`,
    });
  }
);

/**
 * Compose the `ori.md`-declared sources with the local `./features` and any
 * extra `--features` flags, anchored to the declaring workspace. Extracted from
 * {@link resolveDevFeaturesRoot} so that function stays within the line budget;
 * only reached when there is something to compose.
 */
const composeDeclaredAndFlags = Effect.fn("DevCommand.composeDeclared")(
  function* (input: {
    readonly declared: readonly string[];
    readonly extraFeatureFlags: readonly string[];
    readonly localFeaturesRoot: string;
    readonly localWorkspaceRoot: string;
  }) {
    const path = yield* Path.Path;
    const {
      declared,
      extraFeatureFlags,
      localFeaturesRoot,
      localWorkspaceRoot,
    } = input;
    // A relative declared path (`./shared`, `../sibling`) is relative to the
    // `ori.md` that declares it, NOT the process CWD — those differ whenever
    // `--features` points at a workspace elsewhere. Anchor local declared paths to
    // the declaring workspace; leave remote (`github.com/...`) sources and
    // absolute paths untouched (`path.resolve` ignores the base for an absolute).
    const declaredResolved = declared.map((source) =>
      isRemoteFeaturesInput(source)
        ? source
        : path.resolve(localWorkspaceRoot, source)
    );

    // One compose pass: [declared…, local, …extra flags]. Local before the flags
    // and after the declared sources gives the spec'd precedence (local beats
    // declared; flags beat all). Anchor to the local project regardless of order.
    // Map any filesystem PlatformError to CliFailureError so this function keeps a
    // single typed failure (`CliFailureError`) for its callers.
    const composed = yield* composeFeatureRoots(
      [...declaredResolved, localFeaturesRoot, ...extraFeatureFlags],
      { anchorWorkspaceRoot: localWorkspaceRoot }
    ).pipe(
      Effect.mapError((cause) =>
        Schema.is(CliFailureError)(cause)
          ? cause
          : new CliFailureError({
              detail: `Could not compose feature sources: ${formatUnknownError(cause)}`,
            })
      )
    );
    if (composed === undefined) {
      return {
        featuresRoot: localFeaturesRoot,
        workspaceRoot: localWorkspaceRoot,
      };
    }
    return {
      featuresRoot: composed.featuresRoot,
      workspaceRoot: composed.workspaceRoot,
      ...(composed.composed
        ? { workspaceOverride: composed.workspaceRoot }
        : {}),
    };
  }
);

/**
 * Resolve the effective feature root by composing, in one pass, every feature
 * source that applies:
 *   `[…ori.md declared, local ./features (or the single --features base), …extra --features flags]`
 * `composeFeatureRoots` is last-wins on a duplicate feature id, so the local
 * workspace shadows an `ori.md`-declared same-named feature, and repeated
 * `--features` flags shadow everything. The result is anchored to the LOCAL
 * project (its `ori.md`'s workspace) so credentials/config/descriptor resolve
 * there — never `.ori/composed` or a remote source. With no declared sources and
 * no extra flags this is byte-for-byte the old single-root behaviour (no
 * `.ori/composed`). Shared by `start`, `dev`, `code`, `eval`.
 *
 * `features` is the base single source (the first `--features`, or `./features`
 * default); `extraFeatureFlags` are any additional repeated `--features` values
 * (only `ori start` passes more than one today).
 */
const resolveDevFeaturesRoot = Effect.fn("DevCommand.featuresRoot")(function* (
  features: Option.Option<string>,
  extraFeatureFlags: readonly string[] = []
) {
  const path = yield* Path.Path;
  const localFeaturesRoot = yield* resolveLocalFeaturesRoot(features);
  const localWorkspaceRoot = workspaceRootFromFeaturesRoot(
    path,
    localFeaturesRoot
  );

  // An already-materialized `.ori/composed` root is an internal artifact, not a
  // fresh source. `ori start` composes up front and then hands the composed root
  // back through here (via `prepareDevFeaturesRoot`); since the compose step links
  // the declaring workspace's `ori.md` INTO `.ori/composed`, re-reading its
  // `features:` and composing again would resolve declared paths against
  // `.ori/composed` and crash. Short-circuit: the composition already happened.
  if (isComposedFeaturesRoot(localFeaturesRoot)) {
    return {
      featuresRoot: localFeaturesRoot,
      workspaceRoot: localWorkspaceRoot,
    };
  }

  const declared = yield* readOriMdFeatureSources(localWorkspaceRoot);
  if (declared.length === 0 && extraFeatureFlags.length === 0) {
    return {
      featuresRoot: localFeaturesRoot,
      workspaceRoot: localWorkspaceRoot,
    };
  }

  return yield* composeDeclaredAndFlags({
    declared,
    extraFeatureFlags,
    localFeaturesRoot,
    localWorkspaceRoot,
  });
});

const resolveGlobalWorkspaceContext = Effect.fn(
  "DevCommand.globalWorkspaceContext"
)(function* (input: {
  readonly hasExplicitFeatures: boolean;
  readonly workspaceRoot: string;
}) {
  const isGlobalWorkspace =
    input.workspaceRoot === (yield* resolveGlobalWorkspaceRoot());
  const announceGlobalFallback = shouldAnnounceGlobalFallback({
    cwd: yield* currentWorkingDirectory(),
    hasExplicitFeatures: input.hasExplicitFeatures,
    isGlobalWorkspace,
    workspaceRoot: input.workspaceRoot,
  });
  return {
    announceGlobalFallback,
    isGlobalWorkspace,
  };
});

/**
 * Publish the resolved workspace root into the environment so daemon-side
 * services (notably the built-in SQLite catalog) anchor durable state to the
 * workspace rather than the process CWD. This matters under systemd, where
 * `WorkingDirectory` can differ from the workspace. The packed-intern launcher
 * already sets this, so respect an existing value and never override the
 * launcher or an operator's explicit setting.
 */
const exportWorkspaceRootEnv = Effect.fn("DevCommand.exportWorkspaceRootEnv")(
  function* (workspaceRoot: string) {
    const hostProcess = yield* HostProcess;
    const env = yield* hostProcess.env;
    const existing = env[ORI_INTERN_WORKSPACE_ROOT_ENV]?.trim();
    if (existing !== undefined && existing.length > 0) {
      return;
    }
    yield* hostProcess.setEnv(ORI_INTERN_WORKSPACE_ROOT_ENV, workspaceRoot);
  }
);

const prepareDevFeaturesRoot = Effect.fn("DevCommand.prepareFeaturesRoot")(
  function* (config: {
    readonly features: Option.Option<string>;
    readonly install: boolean;
    /**
     * Overrides the workspace root that anchors author-contracts and
     * `ORI_INTERN_WORKSPACE_ROOT`. `ori start` sets this when it consolidates
     * several `--features` sources: the composed features root lives under
     * `.ori/composed`, so `dirname(featuresRoot)` would anchor to the cache dir
     * instead of the real project. Absent → `dirname(featuresRoot)` as before.
     */
    readonly workspaceRoot?: string;
  }) {
    const path = yield* Path.Path;
    const resolved = yield* resolveDevFeaturesRoot(config.features);
    const { featuresRoot } = resolved;
    // Materialize the `.ori/sdk` author-contracts cache before installing. On a
    // fresh clone `.ori/sdk` is gitignored and absent, so `npm install` would fail
    // to resolve the workspace's `"ori": "file:.ori/sdk"` dependency before the
    // post-install refresh in `publishDevDescriptor` ever runs. The write is
    // idempotent and a no-op for workspaces that do not declare the file dependency.
    // Anchor precedence: an explicit caller override (e.g. `ori start` composing
    // --features) > the ori.md-composition anchor > `dirname(featuresRoot)`.
    const workspaceRoot =
      config.workspaceRoot ??
      resolved.workspaceOverride ??
      workspaceRootFromFeaturesRoot(path, featuresRoot);
    yield* ensureAuthorContractsCurrent(workspaceRoot, featuresRoot).pipe(
      Effect.mapError(
        (cause) =>
          new CliFailureError({
            detail: `Could not refresh author contracts in ${workspaceRoot}: ${formatUnknownError(cause)}`,
          })
      )
    );
    const dependencyDecision = yield* ensureDevWorkspaceDependencies({
      featuresRoot,
      install: config.install,
      workspaceRoot,
    });
    yield* restartAfterDevDependencyInstall(dependencyDecision);
    yield* exportWorkspaceRootEnv(workspaceRoot);
    // Return the anchor alongside the features root so every boot path
    // (descriptor, event log, contributions) anchors to the real workspace —
    // not just `ori start`. Without this, a workspace whose `ori.md` declares
    // `features:` composes under `.ori/composed`, and callers that derive the
    // descriptor root as `dirname(featuresRoot)` would write `.ori/dev.json`
    // into the cache dir, where `ori tui`/`ori logs` can never discover it.
    return {
      featuresRoot,
      workspaceRoot,
    };
  }
);

export {
  currentWorkingDirectory,
  FEATURES_DIR,
  prepareDevFeaturesRoot,
  resolveDevFeaturesRoot,
  resolveGlobalWorkspaceContext,
  shouldAnnounceGlobalFallback,
};
