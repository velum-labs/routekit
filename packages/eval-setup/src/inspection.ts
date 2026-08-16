import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";

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
  ".cache",
  ".git",
  ".next",
  ".pnpm-store",
  ".routekit",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "target",
  "vendor"
]);
const MAX_INSPECTION_FILES = 2_000;
const MAX_INSPECTION_ENTRIES = 10_000;
const MAX_INSPECTION_DEPTH = 24;
const MAX_INSPECTION_DIRECTORIES = 1_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".go",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".py",
  ".rs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml"
]);
const MODEL_CALL =
  /(?:chat\.completions|responses\.create|messages\.create|generateContent|model\s*[:=])/u;
const MODEL_ID =
  /\b(?:openai|anthropic|google|meta-llama|mistralai|cohere|x-ai)\/[A-Za-z0-9._~:-]+\b/u;
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

const pathIsWithin = (paths: Path.Path, root: string, candidate: string): boolean => {
  const relative = paths.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
  );
};

const posixPath = (relativePath: string): string => relativePath.split(/[\\/]/u).join("/");

const isTopLevelReadme = (relativePath: string): boolean =>
  /^README\.mdx?$/iu.test(posixPath(relativePath));

const isReadme = (relativePath: string): boolean =>
  /(^|\/)README\.mdx?$/iu.test(posixPath(relativePath));

const isDocPath = (relativePath: string): boolean => {
  const posix = posixPath(relativePath);
  if (isReadme(posix)) return true;
  const segments = posix.split("/");
  const docsIndex = segments.findIndex((segment) => segment.toLowerCase() === "docs");
  if (docsIndex < 0 || docsIndex >= segments.length - 1) return false;
  const ext = segments[segments.length - 1]?.toLowerCase();
  return ext !== undefined && (ext.endsWith(".md") || ext.endsWith(".mdx"));
};

const skipSurfacePath = (relativePath: string): boolean => {
  const posix = posixPath(relativePath);
  const segments = posix.split("/");
  if (
    segments.some((segment) =>
      ["vendor", "generated", "test", "tests", "__tests__"].includes(segment.toLowerCase())
    )
  ) {
    return true;
  }
  const base = segments[segments.length - 1] ?? "";
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(base);
};

const materialKind = (relativePath: string): RepositoryMaterial["kind"] | undefined => {
  if (isDocPath(relativePath)) return "doc";
  const lower = relativePath.toLowerCase();
  if (TEST_NAME.test(lower)) return "test";
  if (FIXTURE_NAME.test(lower)) return "fixture";
  if (DATASET_NAME.test(lower)) return "dataset";
  if (PROMPT_NAME.test(lower)) return "prompt";
  if (SCHEMA_NAME.test(lower)) return "schema";
  return undefined;
};

const materialRank = (material: RepositoryMaterial): number => {
  if (isTopLevelReadme(material.path)) return 0;
  if (material.kind === "doc" && isReadme(material.path)) return 1;
  if (material.kind === "doc") return 2;
  if (material.kind === "prompt") return 3;
  if (material.kind === "fixture") return 4;
  if (material.kind === "dataset") return 5;
  if (material.kind === "schema") return 6;
  return 7;
};

const surfaceRank = (surface: RepositorySurface): number => {
  const posix = posixPath(surface.path);
  if (isTopLevelReadme(posix)) return 0;
  if (posix.startsWith("docs/") || posix.includes("/docs/")) return 1;
  return 2;
};

const compareByPath = (left: string, right: string): number =>
  posixPath(left).localeCompare(posixPath(right));

export const inspectRepository = Effect.fn("EvalSetup.inspectRepository")(function* (
  repositoryRoot: string
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* fs
    .realPath(repositoryRoot)
    .pipe(Effect.mapError((cause) => inspectionFailure(repositoryRoot, cause)));
  const surfaces: RepositorySurface[] = [];
  const materials: RepositoryMaterial[] = [];
  const pendingDirectories: Array<{
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly depth: number;
  }> = [{ absolutePath: root, relativePath: "", depth: 0 }];
  const visitedDirectories = new Set([root]);
  let entriesVisited = 0;
  let textFilesConsidered = 0;
  let filesRead = 0;
  let bytesRead = 0;
  let skippedOversizedFiles = 0;
  let truncated = false;

  while (pendingDirectories.length > 0 && !truncated) {
    const directory = pendingDirectories.shift();
    if (directory === undefined) break;
    const names =
      directory.depth === 0
        ? yield* fs
            .readDirectory(directory.absolutePath)
            .pipe(Effect.mapError((cause) => inspectionFailure(directory.absolutePath, cause)))
        : yield* fs.readDirectory(directory.absolutePath).pipe(Effect.orElseSucceed(() => []));
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (entriesVisited >= MAX_INSPECTION_ENTRIES) {
        truncated = true;
        break;
      }
      entriesVisited += 1;
      const relativePath =
        directory.relativePath.length === 0 ? name : paths.join(directory.relativePath, name);
      if (skippedPath(relativePath)) continue;
      const unresolvedPath = paths.join(directory.absolutePath, name);
      const canonicalOption = yield* fs.realPath(unresolvedPath).pipe(Effect.option);
      if (Option.isNone(canonicalOption)) continue;
      const canonicalPath = canonicalOption.value;
      if (!pathIsWithin(paths, root, canonicalPath)) continue;
      const infoOption = yield* fs.stat(canonicalPath).pipe(Effect.option);
      if (Option.isNone(infoOption)) continue;
      const info = infoOption.value;
      if (info.type === "Directory") {
        if (directory.depth >= MAX_INSPECTION_DEPTH) {
          truncated = true;
          continue;
        }
        if (visitedDirectories.has(canonicalPath)) continue;
        if (visitedDirectories.size >= MAX_INSPECTION_DIRECTORIES) {
          truncated = true;
          continue;
        }
        visitedDirectories.add(canonicalPath);
        pendingDirectories.push({
          absolutePath: canonicalPath,
          relativePath,
          depth: directory.depth + 1
        });
        continue;
      }
      if (info.type !== "File") continue;
      if (!TEXT_EXTENSIONS.has(paths.extname(relativePath).toLowerCase())) continue;
      if (textFilesConsidered >= MAX_INSPECTION_FILES) {
        truncated = true;
        break;
      }
      textFilesConsidered += 1;
      const kind = materialKind(relativePath);
      if (kind !== undefined) materials.push({ kind, path: relativePath });
      const fileBytes = Number(info.size);
      if (fileBytes > MAX_FILE_BYTES) {
        skippedOversizedFiles += 1;
        continue;
      }
      if (bytesRead + fileBytes > MAX_TOTAL_BYTES) {
        skippedOversizedFiles += 1;
        truncated = true;
        break;
      }
      const contentOption = yield* fs.readFileString(canonicalPath).pipe(Effect.option);
      if (Option.isNone(contentOption)) continue;
      filesRead += 1;
      bytesRead += fileBytes;
      const content = contentOption.value;
      if (skipSurfacePath(relativePath) || !MODEL_CALL.test(content)) continue;
      const model = MODEL_ID.exec(content)?.[0];
      surfaces.push({
        name: relativePath.replace(/\.[^.]+$/u, ""),
        path: relativePath,
        ...(model === undefined ? {} : { model })
      });
    }
  }
  materials.sort((left, right) => {
    const rank = materialRank(left) - materialRank(right);
    return rank !== 0 ? rank : compareByPath(left.path, right.path);
  });
  surfaces.sort((left, right) => {
    const rank = surfaceRank(left) - surfaceRank(right);
    return rank !== 0 ? rank : compareByPath(left.path, right.path);
  });
  if (surfaces.length === 0 && materials.some((material) => isTopLevelReadme(material.path))) {
    surfaces.push({ name: "repository-docs", path: "README.md" });
  }
  return {
    repositoryRoot: root,
    surfaces,
    materials,
    summary: {
      entriesVisited,
      textFilesConsidered,
      filesRead,
      bytesRead,
      skippedOversizedFiles,
      truncated
    }
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
