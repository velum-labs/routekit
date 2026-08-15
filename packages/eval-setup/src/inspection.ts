import { Context, Effect, FileSystem, Layer, Path } from "effect";

import { EvalSetupInspectionError } from "./errors.js";
import type { RepositoryInspection, RepositoryMaterial, RepositorySurface } from "./types.js";

export type EvalRepositoryInspectorShape = {
  readonly inspect: (
    repositoryRoot: string
  ) => Effect.Effect<RepositoryInspection, EvalSetupInspectionError>;
};

export class EvalRepositoryInspector extends Context.Service<
  EvalRepositoryInspector,
  EvalRepositoryInspectorShape
>()("@velum-labs/routekit-eval-setup/EvalRepositoryInspector") {}

const IGNORED_SEGMENTS = new Set([
  ".git",
  ".routekit",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "target"
]);
const MAX_INSPECTION_FILES = 2_000;
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".go",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml"
]);
const MODEL_CALL = /(?:chat\.completions|responses\.create|messages\.create|generateContent|model\s*[:=])/u;
const MODEL_ID = /\b(?:openai|anthropic|google|meta-llama|mistralai|cohere|x-ai)\/[A-Za-z0-9._~:-]+\b/u;
const PROMPT_NAME = /(?:^|[-_.])(prompt|system|instructions?)(?:[-_.]|$)/iu;
const DATASET_NAME = /(?:dataset|cases?|examples?|samples?|traffic)/iu;
const FIXTURE_NAME = /(?:fixture|gold|expected)/iu;
const TEST_NAME = /(?:^|[-_.])(test|spec)(?:[-_.]|$)/iu;
const SCHEMA_NAME = /(?:schema|output)/iu;

const inspectionFailure = (path: string, cause: unknown): EvalSetupInspectionError =>
  new EvalSetupInspectionError({
    path,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause
  });

const skippedPath = (relativePath: string): boolean =>
  relativePath.split(/[\\/]/u).some((segment) => IGNORED_SEGMENTS.has(segment));

const materialKind = (relativePath: string): RepositoryMaterial["kind"] | undefined => {
  const lower = relativePath.toLowerCase();
  if (TEST_NAME.test(lower)) return "test";
  if (FIXTURE_NAME.test(lower)) return "fixture";
  if (DATASET_NAME.test(lower)) return "dataset";
  if (PROMPT_NAME.test(lower)) return "prompt";
  if (SCHEMA_NAME.test(lower)) return "schema";
  return undefined;
};

export const inspectRepository = Effect.fn("EvalSetup.inspectRepository")(function* (
  repositoryRoot: string
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* fs
    .realPath(repositoryRoot)
    .pipe(Effect.mapError((cause) => inspectionFailure(repositoryRoot, cause)));
  const entries = yield* fs
    .readDirectory(root, { recursive: true })
    .pipe(Effect.mapError((cause) => inspectionFailure(root, cause)));
  const files = entries
    .filter((entry) => !skippedPath(entry))
    .filter((entry) => TEXT_EXTENSIONS.has(paths.extname(entry).toLowerCase()))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_INSPECTION_FILES);
  const surfaces: RepositorySurface[] = [];
  const materials: RepositoryMaterial[] = [];
  for (const relativePath of files) {
    const kind = materialKind(relativePath);
    if (kind !== undefined) materials.push({ kind, path: relativePath });
    const absolute = paths.join(root, relativePath);
    const content = yield* fs.readFileString(absolute).pipe(Effect.orElseSucceed(() => ""));
    if (!MODEL_CALL.test(content)) continue;
    const model = MODEL_ID.exec(content)?.[0];
    surfaces.push({
      name: relativePath.replace(/\.[^.]+$/u, ""),
      path: relativePath,
      ...(model === undefined ? {} : { model })
    });
  }
  return {
    repositoryRoot: root,
    surfaces,
    materials
  } satisfies RepositoryInspection;
});

export const EvalRepositoryInspectorLive = Layer.effect(
  EvalRepositoryInspector,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    return EvalRepositoryInspector.of({
      inspect: (repositoryRoot) =>
        inspectRepository(repositoryRoot).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, paths)
        )
    });
  })
);
