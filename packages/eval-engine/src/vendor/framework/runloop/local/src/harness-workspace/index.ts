import type { FileSystem, Path } from "effect";

import { join as joinPath } from "node:path";

import { Context, Crypto, Effect, Encoding, Layer } from "effect";

import type { FeatureLogger } from "../../../../contracts/author/src/index.ts";
import type { SkillRegistryEntry } from "../../../../contracts/internal/src/author-schemas/skill.ts";
import type { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import type { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";
import type { SkillMaterialization } from "./snapshot.ts";
import type {
  HarnessWorkspacePaths,
  MaterializedSkillsManifest,
} from "./steps.ts";

import {
  isPackedInternEnv,
  readPersonaEnv,
} from "../../../../contracts/internal/src/cli/intern-launcher-env.ts";
import { reconcileSkillLinks } from "./links.ts";
import {
  EMPTY_GENERATION,
  makeSkillMaterializations,
  readMaterializedSkillsManifest,
  writeMaterializedSkillsManifest,
} from "./materialize.ts";
import {
  ensureSnapshotGeneration,
  makeSnapshotGenerationPath,
  makeSkillSetFingerprint,
} from "./snapshot.ts";
import {
  makeDesiredSkillLinks,
  makeHarnessWorkspacePaths,
  makeManifest,
  resolveHarnessWorkspaceRoot,
} from "./steps.ts";

import {
  ensureCodeSkillsWrapper,
  ensureFrameworkSkillWrapper,
} from "./framework-wrapper.ts";

export interface HarnessWorkspace {
  readonly cwd: string;
  readonly generation: number;
  readonly nativeSkillDir?: string | undefined;
  readonly skillCount: number;
  readonly warnings: readonly string[];
}

export interface PrepareHarnessWorkspaceInput {
  /** Override the default workspace root anchor for disjoint features roots. */
  readonly anchorToCwd?: boolean | undefined;
  readonly codePersona?: boolean | undefined;
  readonly frameworkSkillRoot?: string | undefined;
  readonly useFrameworkSkillDir?: boolean | undefined;
  readonly cwd: string;
  readonly featuresRoot: string;
  readonly skills: readonly SkillRegistryEntry[];
  readonly workspaceFeatureIds: readonly string[];
}

export interface HarnessWorkspaceMaterializerShape {
  readonly prepare: (
    input: PrepareHarnessWorkspaceInput
  ) => Effect.Effect<HarnessWorkspace, RuntimeServerError>;
}

const reconcileAndPersist = Effect.fn(
  "HarnessWorkspaceMaterializer.reconcileAndPersist"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly fingerprint: string;
    readonly generation: number;
    readonly materializations: readonly SkillMaterialization[];
    readonly paths: HarnessWorkspacePaths;
    readonly previousManifest: MaterializedSkillsManifest;
    readonly workspaceRoot: string;
  }
) {
  const desiredLinks = makeDesiredSkillLinks(path, {
    materializations: input.materializations,
    workspaceRoot: input.workspaceRoot,
  });
  const reconciliation = yield* reconcileSkillLinks(fs, path, {
    desiredLinks,
    paths: input.paths,
    previousLinks: input.previousManifest.links,
    previousOwnedPaths: new Set(input.previousManifest.links),
  });
  yield* writeMaterializedSkillsManifest(fs, path, {
    manifest: makeManifest({
      fingerprint: input.fingerprint,
      generation: input.generation,
      links: reconciliation.materializedRelativePaths,
    }),
    manifestPath: input.paths.manifestPath,
  });
  return reconciliation;
});

const makeProjectSkillMaterializations = Effect.fn(
  "HarnessWorkspaceMaterializer.makeProjectSkillMaterializations"
)(function* (
  fs: FileSystem.FileSystem,
  input: {
    readonly featuresRoot: string;
    readonly path: Path.Path;
    readonly skills: readonly SkillRegistryEntry[];
    readonly workspaceFeatureIds: readonly string[];
    readonly useFrameworkSkillDir: boolean;
  }
) {
  return yield* makeSkillMaterializations(fs, input.path, {
    featuresRoot: input.featuresRoot,
    skills: input.useFrameworkSkillDir
      ? input.skills.filter(
          (skill) => !input.workspaceFeatureIds.includes(skill.featureId)
        )
      : input.skills,
  });
});

const ensureWorkspaceSnapshotGeneration = Effect.fn(
  "HarnessWorkspaceMaterializer.ensureWorkspaceSnapshotGeneration"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly fingerprint: string;
    readonly materializations: readonly SkillMaterialization[];
    readonly previousManifest: MaterializedSkillsManifest;
    readonly snapshotRoot: string;
  }
) {
  return yield* ensureSnapshotGeneration(fs, path, {
    fingerprint: input.fingerprint,
    materializations: input.materializations,
    previous: {
      fingerprint: input.previousManifest.fingerprint,
      generation: input.previousManifest.generation,
    },
    snapshotRoot: input.snapshotRoot,
  });
});

const makeFrameworkSkillMaterializations = Effect.fn(
  "HarnessWorkspaceMaterializer.makeFrameworkSkillMaterializations"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly featuresRoot: string;
    readonly skills: readonly SkillRegistryEntry[];
    readonly workspaceFeatureIds: readonly string[];
    readonly useFrameworkSkillDir: boolean;
  }
) {
  return input.useFrameworkSkillDir
    ? yield* makeSkillMaterializations(fs, path, {
        featuresRoot: input.featuresRoot,
        skills: input.skills.filter((skill) =>
          input.workspaceFeatureIds.includes(skill.featureId)
        ),
      })
    : {
        materializations: [],
        warnings: [],
      };
});

const makeSkillMaterializationSets = Effect.fn(
  "HarnessWorkspaceMaterializer.makeSkillMaterializationSets"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly paths: HarnessWorkspacePaths;
    readonly skills: readonly SkillRegistryEntry[];
    readonly workspaceFeatureIds: readonly string[];
    readonly useFrameworkSkillDir: boolean;
  }
) {
  const materializationResult = yield* makeSkillMaterializations(fs, path, {
    featuresRoot: input.paths.featuresRoot,
    skills: input.skills,
  });
  const projectResult = yield* makeProjectSkillMaterializations(fs, {
    featuresRoot: input.paths.featuresRoot,
    path,
    skills: input.skills,
    workspaceFeatureIds: input.workspaceFeatureIds,
    useFrameworkSkillDir: input.useFrameworkSkillDir,
  });
  const frameworkResult = yield* makeFrameworkSkillMaterializations(fs, path, {
    featuresRoot: input.paths.featuresRoot,
    skills: input.skills,
    workspaceFeatureIds: input.workspaceFeatureIds,
    useFrameworkSkillDir: input.useFrameworkSkillDir,
  });
  return {
    frameworkMaterializations: frameworkResult.materializations,
    materializationWarnings: [
      ...new Set([
        ...materializationResult.warnings,
        ...projectResult.warnings,
        ...frameworkResult.warnings,
      ]),
    ],
    materializations: materializationResult.materializations,
    projectMaterializations: projectResult.materializations,
  };
});

const prepareSkillMaterializationState = Effect.fn(
  "HarnessWorkspaceMaterializer.prepareSkillMaterializationState"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly paths: HarnessWorkspacePaths;
    readonly skills: readonly SkillRegistryEntry[];
    readonly workspaceFeatureIds: readonly string[];
    readonly useFrameworkSkillDir: boolean;
    readonly codePersona: boolean;
  }
) {
  const {
    frameworkMaterializations,
    materializationWarnings,
    materializations,
    projectMaterializations,
  } = yield* makeSkillMaterializationSets(fs, path, input);
  const snapshotMaterializations = input.codePersona
    ? materializations
    : projectMaterializations;
  const frameworkFingerprint = yield* makeSkillSetFingerprint(
    fs,
    path,
    frameworkMaterializations
  );
  const fingerprint = yield* makeSkillSetFingerprint(
    fs,
    path,
    snapshotMaterializations
  );
  const previousManifest = yield* readMaterializedSkillsManifest(
    fs,
    input.paths.manifestPath
  );
  const generation = yield* ensureWorkspaceSnapshotGeneration(fs, path, {
    fingerprint,
    materializations: snapshotMaterializations,
    previousManifest,
    snapshotRoot: input.paths.snapshotRoot,
  });
  return {
    fingerprint,
    frameworkFingerprint,
    frameworkMaterializations,
    generation,
    materializations,
    materializationWarnings,
    previousManifest,
    projectMaterializations,
  };
});

export const prepareHarnessWorkspace = Effect.fn(
  "HarnessWorkspaceMaterializer.prepare"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: PrepareHarnessWorkspaceInput
): Effect.fn.Return<HarnessWorkspace, RuntimeServerError, Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto;
  const workspaceRoot = resolveHarnessWorkspaceRoot(path, input);
  const paths = makeHarnessWorkspacePaths(
    path,
    input.featuresRoot,
    workspaceRoot
  );
  const { snapshotRoot } = paths;
  const frameworkCodeSkillsRoot =
    input.frameworkSkillRoot === undefined
      ? paths.codeSkillsRoot
      : path.join(input.frameworkSkillRoot, ".ori", "framework-skills");
  const state = yield* prepareSkillMaterializationState(fs, path, {
    codePersona: Boolean(input.codePersona),
    paths,
    skills: input.skills,
    workspaceFeatureIds: input.workspaceFeatureIds,
    useFrameworkSkillDir: Boolean(input.useFrameworkSkillDir),
  });
  const frameworkSkillGenerationKey = Encoding.encodeHex(
    yield* crypto
      .digest("SHA-256", new TextEncoder().encode(state.frameworkFingerprint))
      .pipe(Effect.orDie)
  );
  if (input.useFrameworkSkillDir) {
    yield* input.codePersona
      ? ensureCodeSkillsWrapper(fs, path, {
          codeSkillsRoot: frameworkCodeSkillsRoot,
          crypto,
          generationDir: makeSnapshotGenerationPath(
            path,
            snapshotRoot,
            state.generation
          ),
        })
      : ensureFrameworkSkillWrapper(fs, path, {
          codeSkillsRoot: frameworkCodeSkillsRoot,
          crypto,
          fingerprint: frameworkSkillGenerationKey,
          materializations: state.frameworkMaterializations,
        });
  }

  const reconciliation = yield* reconcileAndPersist(fs, path, {
    fingerprint: state.fingerprint,
    generation: state.generation,
    materializations: state.projectMaterializations,
    paths,
    previousManifest: state.previousManifest,
    workspaceRoot,
  });

  return {
    cwd: workspaceRoot,
    generation: state.generation,
    nativeSkillDir: input.useFrameworkSkillDir
      ? frameworkCodeSkillsRoot
      : paths.snapshotCurrent,
    skillCount: state.materializations.length,
    warnings: [...state.materializationWarnings, ...reconciliation.warnings],
  };
});

/**
 * Prepare the harness workspace for a run, selecting the framework-owned skill
 * directory for every non-packed runtime. Framework-owned skills are kept in
 * the disjoint runtime workspace and passed to the harness through its native
 * skill directory, never through project-level skill links.
 */
export const prepareAndLogWorkspace = Effect.fn(
  "HarnessWorkspaceMaterializer.prepareAndLog"
)(function* (
  materializer: HarnessWorkspaceMaterializerShape,
  hostProcess: HostProcess["Service"],
  input: PrepareHarnessWorkspaceInput & {
    readonly diagnosticsLogger: FeatureLogger;
    readonly harnessName: string | undefined;
    readonly model: string | null | undefined;
  }
) {
  const env = yield* hostProcess.env;
  const persona = readPersonaEnv(env);
  const codePersona = persona === "code";
  const useFrameworkSkillDir = !isPackedInternEnv(env);
  const homeDirectory = yield* hostProcess.homeDirectory;
  const workspace = yield* materializer.prepare({
    ...input,
    codePersona,
    ...(codePersona
      ? {}
      : { frameworkSkillRoot: joinPath(homeDirectory, ".ori", "global") }),
    useFrameworkSkillDir,
    ...(codePersona ? { anchorToCwd: false } : {}),
  });
  const resolvedWorkspace: HarnessWorkspace = codePersona
    ? {
        ...workspace,
        cwd: input.cwd,
      }
    : workspace;
  for (const warning of resolvedWorkspace.warnings) {
    input.diagnosticsLogger.warn(warning);
  }
  input.diagnosticsLogger.debug("invoking harness", {
    cwd: resolvedWorkspace.cwd,
    harness: input.harnessName ?? "default",
    model: input.model ?? "default",
  });
  return resolvedWorkspace;
});

/**
 * Runtime service for materializing the harness workspace on disk. The live
 * layer that reads from Crypto/FileSystem/Path lives in
 * `HarnessWorkspaceMaterializerLive` (`harness-workspace-live.ts`);
 * {@link HarnessWorkspaceMaterializer.layerTest} provides an inert stand-in
 * for tests.
 */
export class HarnessWorkspaceMaterializer extends Context.Service<
  HarnessWorkspaceMaterializer,
  HarnessWorkspaceMaterializerShape
>()("ori/runtime/HarnessWorkspaceMaterializer") {
  static readonly layerTest = (
    impl: Partial<HarnessWorkspaceMaterializerShape> = {}
  ): Layer.Layer<HarnessWorkspaceMaterializer> =>
    Layer.succeed(HarnessWorkspaceMaterializer)(
      HarnessWorkspaceMaterializer.of({
        prepare: (input) =>
          Effect.succeed({
            cwd: input.cwd,
            generation: EMPTY_GENERATION,
            nativeSkillDir: undefined,
            skillCount: input.skills.length,
            warnings: [],
          }),
        ...impl,
      })
    );
}
