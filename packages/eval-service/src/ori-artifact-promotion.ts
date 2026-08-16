import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from "node:fs/promises";
import path from "node:path";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import type {
  CompiledRoutingPolicy,
  EvalComparisonResult,
  PublishedRoutingSnapshot,
  RoutingProfile
} from "@velum-labs/routekit-eval-contracts";
import { assertExplicitEvalModel, assertRoutingProfile } from "@velum-labs/routekit-eval-contracts";
import { compileRoutingPolicy } from "@velum-labs/routekit-eval-core";
import type {
  EvalEngineValidation,
  EvalExecutionOutput,
  EvalExecutionPortService
} from "@velum-labs/routekit-eval-engine";
import {
  evalExecutionModels,
  makeEvalEngineLayer,
  normalizeEvalComparisonEvidence,
  validateEvals
} from "@velum-labs/routekit-eval-engine";
import { makeRoutingSnapshotStore } from "@velum-labs/routekit-eval-store";
import { Data, Effect, Layer } from "effect";

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"] as const;
const RESERVED_SEGMENTS = new Set([".git", ".ori", "node_modules"]);

const MODULE_REFERENCE =
  /\b(?:import|export)\s+(?:[^\n"'`;]*?\sfrom\s*)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/gu;
const URL_REFERENCE = /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/gu;
const FILE_REFERENCE = /\b(?:readFile|readFileSync)\s*\(\s*["']([^"']+)["']/gu;

export interface OriStructuredEvalRun extends EvalExecutionOutput {
  readonly endedAt?: string;
  readonly exitCode: number;
  readonly files: readonly string[];
  readonly finishedAt?: string;
  readonly runId?: string;
  readonly startedAt?: string;
  readonly workingDirectory: string;
}

export interface CompletedOriLibraryResult {
  readonly attempt?: {
    readonly startedAt?: string;
  };
  readonly evalRuns: readonly OriStructuredEvalRun[];
  readonly ok: boolean;
  readonly scratchWorkspace?: string;
  readonly state?: {
    readonly scratchWorkspace?: string;
    readonly status?: string;
  };
  readonly status?: string;
}

export interface ResolvedOriEvalRun extends OriStructuredEvalRun {
  readonly finishedAt: string;
  readonly startedAt: string;
}

export interface OriArtifactPromotionInput {
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly result: CompletedOriLibraryResult;
}

export interface PromotedOriEvalArtifacts {
  readonly directory: string;
  readonly evalFiles: readonly string[];
  readonly run: ResolvedOriEvalRun;
  readonly suiteDigest: string;
  readonly supportFiles: readonly string[];
}

export interface OriPolicyHandoffInput {
  readonly profile: RoutingProfile;
  readonly repositoryRoot: string;
  readonly result: CompletedOriLibraryResult;
  readonly snapshotRoot: string;
}

export interface OriPolicyHandoffResult extends PromotedOriEvalArtifacts {
  readonly comparison: EvalComparisonResult;
  readonly policy: CompiledRoutingPolicy;
  readonly snapshot: PublishedRoutingSnapshot;
}

type FailureFields = {
  readonly cause?: unknown;
  readonly detail: string;
  readonly operation: string;
};

export class OriArtifactPromotionError extends Data.TaggedError(
  "OriArtifactPromotionError"
)<FailureFields> {
  override get message(): string {
    return `Ori eval artifact promotion failed while ${this.operation}: ${this.detail}`;
  }
}

export class OriPolicyHandoffError extends Data.TaggedError(
  "OriPolicyHandoffError"
)<FailureFields> {
  override get message(): string {
    return `Ori eval policy handoff failed while ${this.operation}: ${this.detail}`;
  }
}

interface StagedPromotion {
  readonly destination: string;
  readonly evalRelativePaths: readonly string[];
  readonly run: ResolvedOriEvalRun;
  readonly staging: string;
  readonly suiteDigest: string;
  readonly supportRelativePaths: readonly string[];
}

const detailOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const promotionError = (operation: string, cause: unknown): OriArtifactPromotionError =>
  cause instanceof OriArtifactPromotionError
    ? cause
    : new OriArtifactPromotionError({ operation, detail: detailOf(cause), cause });

const handoffError = (operation: string, cause: unknown): OriPolicyHandoffError =>
  cause instanceof OriPolicyHandoffError
    ? cause
    : new OriPolicyHandoffError({ operation, detail: detailOf(cause), cause });

const requireIsoTimestamp = (label: string, value: string | undefined): string => {
  if (value === undefined || value.trim().length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return new Date(value).toISOString();
};

/**
 * Select the newest successful structured run from a completed Ori library result.
 * Human recommendation/report text is intentionally outside this contract.
 */
export const selectLatestSuccessfulOriEvalRun = (
  result: CompletedOriLibraryResult
): ResolvedOriEvalRun => {
  const status = result.status ?? result.state?.status;
  if (!result.ok || status !== "completed") {
    throw new Error(
      `Ori library result must be successful and completed, received ${status ?? "unknown"}`
    );
  }
  const successful = result.evalRuns
    .filter((run) => run.exitCode === 0)
    .map((run) => {
      const startedAt = requireIsoTimestamp(
        "structured eval run startedAt",
        run.startedAt ?? result.attempt?.startedAt
      );
      const finishedAt = requireIsoTimestamp(
        "structured eval run finishedAt",
        run.finishedAt ?? run.endedAt
      );
      if (Date.parse(finishedAt) < Date.parse(startedAt)) {
        throw new Error("structured eval run finishedAt precedes startedAt");
      }
      if (run.files.length === 0) {
        throw new Error("successful structured eval run contains no eval files");
      }
      return { ...run, startedAt, finishedAt };
    })
    .sort((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt));
  const latest = successful[0];
  if (latest === undefined) {
    throw new Error("completed Ori library result contains no successful structured eval run");
  }
  return latest;
};

const isContained = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};

const assertSafeRelativePath = (relativePath: string): void => {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath
      .split(path.sep)
      .some((segment) => segment === ".." || RESERVED_SEGMENTS.has(segment))
  ) {
    throw new Error(`unsafe promoted artifact path ${JSON.stringify(relativePath)}`);
  }
};

const realContainedPath = async (workspace: string, candidate: string): Promise<string> => {
  const resolved = path.resolve(candidate);
  const canonical = await realpath(resolved);
  if (!isContained(workspace, canonical)) {
    throw new Error(`artifact path escapes the scratch workspace: ${candidate}`);
  }
  return canonical;
};

const matches = (source: string, pattern: RegExp): readonly string[] => {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].flatMap((match) => {
    const value = match[1] ?? match[2];
    return value === undefined ? [] : [value];
  });
};

const sourceReferences = (
  source: string
): readonly { readonly kind: "module" | "resource"; readonly specifier: string }[] => [
  ...matches(source, MODULE_REFERENCE).map((specifier) => ({
    kind: "module" as const,
    specifier
  })),
  ...matches(source, URL_REFERENCE).map((specifier) => ({
    kind: "resource" as const,
    specifier
  })),
  ...matches(source, FILE_REFERENCE).map((specifier) => ({
    kind: "resource" as const,
    specifier
  }))
];

const resolveReference = async (
  workspace: string,
  sourceFile: string,
  reference: { readonly kind: "module" | "resource"; readonly specifier: string }
): Promise<string | undefined> => {
  const specifier = reference.specifier.split(/[?#]/u, 1)[0] ?? "";
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier) && !specifier.startsWith("file:")) {
    return undefined;
  }
  if (!specifier.startsWith(".")) {
    throw new Error(
      `non-relative support reference ${JSON.stringify(reference.specifier)} in ${sourceFile}`
    );
  }
  const base = path.resolve(path.dirname(sourceFile), specifier);
  if (!isContained(workspace, base)) {
    throw new Error(`support reference escapes the scratch workspace: ${reference.specifier}`);
  }
  const candidates =
    reference.kind === "module" && path.extname(base) === ""
      ? [
          base,
          ...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`),
          ...MODULE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`))
        ]
      : [base];
  for (const candidate of candidates) {
    try {
      return await realContainedPath(workspace, candidate);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
    }
  }
  throw new Error(`referenced support artifact does not exist: ${reference.specifier}`);
};

const directoryFiles = async (workspace: string, directory: string): Promise<readonly string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in promoted support data: ${candidate}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await directoryFiles(workspace, candidate)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`only regular support files can be promoted: ${candidate}`);
    }
    files.push(await realContainedPath(workspace, candidate));
  }
  return files;
};

const collectArtifacts = async (
  workspace: string,
  evalFiles: readonly string[]
): Promise<ReadonlyMap<string, string>> => {
  const pending = [...evalFiles];
  const collected = new Map<string, string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const info = await lstat(current);
    const additions = info.isDirectory() ? await directoryFiles(workspace, current) : [current];
    for (const file of additions) {
      const relative = path.relative(workspace, file);
      assertSafeRelativePath(relative);
      if (collected.has(relative)) continue;
      const fileInfo = await stat(file);
      if (!fileInfo.isFile()) throw new Error(`promoted artifact is not a regular file: ${file}`);
      collected.set(relative, file);
      if (!SCRIPT_EXTENSIONS.has(path.extname(file))) continue;
      const source = await readFile(file, "utf8");
      for (const reference of sourceReferences(source)) {
        const resolved = await resolveReference(workspace, file, reference);
        if (resolved !== undefined) pending.push(resolved);
      }
    }
  }
  return collected;
};

const artifactDigest = async (artifacts: ReadonlyMap<string, string>): Promise<string> => {
  const hash = createHash("sha256");
  for (const [relative, source] of [...artifacts.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    hash.update(relative.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(source));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const stagePromotion = async (input: OriArtifactPromotionInput): Promise<StagedPromotion> => {
  if (!PROFILE_ID.test(input.profileId) || input.profileId === "." || input.profileId === "..") {
    throw new Error(`unsafe routing profile id ${JSON.stringify(input.profileId)}`);
  }
  const run = selectLatestSuccessfulOriEvalRun(input.result);
  const scratch = input.result.scratchWorkspace ?? input.result.state?.scratchWorkspace;
  if (scratch === undefined || scratch.trim().length === 0) {
    throw new Error("completed Ori library result does not identify its scratch workspace");
  }
  const workspace = await realpath(path.resolve(scratch));
  if (!(await stat(workspace)).isDirectory()) {
    throw new Error("Ori scratch workspace is not a directory");
  }
  const workingDirectory = await realpath(path.resolve(run.workingDirectory));
  if (!isContained(workspace, workingDirectory)) {
    throw new Error("structured eval run workingDirectory is outside the Ori scratch workspace");
  }
  const evalFiles = await Promise.all(
    run.files.map(async (file) => {
      const resolved = await realContainedPath(
        workspace,
        path.isAbsolute(file) ? file : path.resolve(workingDirectory, file)
      );
      if (!resolved.endsWith(".eval.ts")) {
        throw new Error(`structured eval run file is not an authored *.eval.ts file: ${file}`);
      }
      return resolved;
    })
  );
  const artifacts = await collectArtifacts(workspace, evalFiles);
  const measuredEvalPaths = new Set(evalFiles.map((file) => path.relative(workspace, file)));
  const extraEval = [...artifacts.keys()].find(
    (relative) => relative.endsWith(".eval.ts") && !measuredEvalPaths.has(relative)
  );
  if (extraEval !== undefined) {
    throw new Error(`referenced eval file was not measured by the structured run: ${extraEval}`);
  }

  const repositoryRoot = await realpath(path.resolve(input.repositoryRoot));
  const evalsRoot = path.join(repositoryRoot, ".routekit", "evals");
  await mkdir(evalsRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(evalsRoot, input.profileId);
  const staging = path.join(evalsRoot, `.${input.profileId}.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    for (const [relative, source] of artifacts) {
      const target = path.join(staging, relative);
      assertSafeRelativePath(path.relative(staging, target));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target, constants.COPYFILE_EXCL);
    }
    const evalRelativePaths = [...measuredEvalPaths].sort();
    return {
      destination,
      evalRelativePaths,
      run,
      staging,
      suiteDigest: await artifactDigest(artifacts),
      supportRelativePaths: [...artifacts.keys()]
        .filter((relative) => !measuredEvalPaths.has(relative))
        .sort()
    };
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }
};

const commitPromotion = async (staged: StagedPromotion): Promise<PromotedOriEvalArtifacts> => {
  const backup = `${staged.destination}.previous-${randomUUID()}`;
  let movedPrevious = false;
  try {
    try {
      await rename(staged.destination, backup);
      movedPrevious = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    await rename(staged.staging, staged.destination);
  } catch (cause) {
    if (movedPrevious) {
      await rename(backup, staged.destination).catch(() => undefined);
    }
    throw cause;
  }
  if (movedPrevious) await rm(backup, { recursive: true, force: true });
  return {
    directory: staged.destination,
    evalFiles: staged.evalRelativePaths.map((relative) => path.join(staged.destination, relative)),
    run: staged.run,
    suiteDigest: staged.suiteDigest,
    supportFiles: staged.supportRelativePaths.map((relative) =>
      path.join(staged.destination, relative)
    )
  };
};

const noExecution: EvalExecutionPortService = {
  execute: () => Effect.die(new Error("validation must never execute eval calls"))
};

const validateStagedSuite = (
  staged: StagedPromotion
): Effect.Effect<EvalEngineValidation, OriArtifactPromotionError> =>
  validateEvals(staged.staging).pipe(
    Effect.provide(Layer.mergeAll(makeEvalEngineLayer(noExecution), NodeServicesLayer)),
    Effect.mapError((cause) => promotionError("validating the staged suite", cause)),
    Effect.flatMap((validation) => {
      const discovered = validation.files.map((file) => path.relative(staged.staging, file)).sort();
      return discovered.length === staged.evalRelativePaths.length &&
        discovered.every((file, index) => file === staged.evalRelativePaths[index])
        ? Effect.succeed(validation)
        : Effect.fail(
            promotionError(
              "validating the staged suite",
              new Error("validated eval files do not match the latest successful structured run")
            )
          );
    })
  );

export const promoteOriEvalArtifacts = (
  input: OriArtifactPromotionInput
): Effect.Effect<PromotedOriEvalArtifacts, OriArtifactPromotionError> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => stagePromotion(input),
      catch: (cause) => promotionError("staging structured artifacts", cause)
    }),
    (staged) =>
      Effect.tryPromise(() => rm(staged.staging, { recursive: true, force: true })).pipe(
        Effect.ignore
      )
  ).pipe(
    Effect.flatMap((staged) =>
      validateStagedSuite(staged).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => commitPromotion(staged),
            catch: (cause) => promotionError("atomically replacing the profile artifacts", cause)
          })
        )
      )
    ),
    Effect.scoped
  );

const validateObservedModels = (
  profile: RoutingProfile,
  run: ResolvedOriEvalRun
): {
  readonly candidateModels: readonly string[];
  readonly judgeModel: string;
} => {
  assertRoutingProfile(profile);
  const observed = evalExecutionModels(run);
  if (observed.candidateModels.length === 0) {
    throw new Error("structured eval evidence contains no candidate models");
  }
  for (const candidate of observed.candidateModels) {
    assertExplicitEvalModel(candidate, "candidate");
  }
  if (observed.judgeModels.length !== 1) {
    throw new Error(
      `structured eval evidence must contain exactly one judge model, found ${observed.judgeModels.length}`
    );
  }
  const judgeModel = observed.judgeModels[0];
  if (judgeModel === undefined) throw new Error("structured eval evidence contains no judge model");
  assertExplicitEvalModel(judgeModel, "judge");
  if (judgeModel !== profile.judge) {
    throw new Error(
      `observed judge ${JSON.stringify(judgeModel)} does not match profile judge ${JSON.stringify(profile.judge)}`
    );
  }
  const expected = new Set(profile.candidates);
  const unexpected = observed.candidateModels.filter((model) => !expected.has(model));
  const observedSet = new Set(observed.candidateModels);
  const missing = profile.candidates.filter((model) => !observedSet.has(model));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `observed candidates do not match the profile (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`
    );
  }
  const candidateRowCount = run.results.filter((row) => row.role !== "judge").length;
  if (run.tests.length === 0 || run.tests.length !== candidateRowCount) {
    throw new Error(
      `structured eval test evidence does not match candidate rows (tests: ${run.tests.length}; candidate rows: ${candidateRowCount})`
    );
  }
  const incomplete = run.results.filter((row) => row.cutOff || row.outcome === "unknown").length;
  if (incomplete > 0) {
    throw new Error(`structured eval evidence contains ${incomplete} cutoff or unknown run(s)`);
  }
  return { candidateModels: observed.candidateModels, judgeModel };
};

const comparisonIdFor = (run: ResolvedOriEvalRun): string =>
  run.runId?.trim() ||
  createHash("sha256")
    .update(
      JSON.stringify({
        files: run.files,
        finishedAt: run.finishedAt,
        startedAt: run.startedAt,
        workingDirectory: run.workingDirectory
      })
    )
    .digest("hex");

/**
 * Promote, validate, normalize, compile, and publish an already-measured Ori run.
 * No recommendation prose is accepted and no candidate or judge calls are made.
 */
export const publishOriEvalPolicyHandoff = (
  input: OriPolicyHandoffInput
): Effect.Effect<OriPolicyHandoffResult, OriArtifactPromotionError | OriPolicyHandoffError> =>
  Effect.gen(function* () {
    const run = yield* Effect.try({
      try: () => selectLatestSuccessfulOriEvalRun(input.result),
      catch: (cause) => handoffError("selecting structured eval evidence", cause)
    });
    const models = yield* Effect.try({
      try: () => validateObservedModels(input.profile, run),
      catch: (cause) => handoffError("validating observed model roles", cause)
    });
    const promoted = yield* promoteOriEvalArtifacts({
      profileId: input.profile.id,
      repositoryRoot: input.repositoryRoot,
      result: input.result
    });
    const comparison = yield* normalizeEvalComparisonEvidence({
      comparisonId: comparisonIdFor(run),
      request: {
        version: 1,
        profileId: input.profile.id,
        suitePath: promoted.directory,
        candidateModels: models.candidateModels,
        judgeModel: models.judgeModel,
        gatewayUrl: "http://127.0.0.1"
      },
      output: run,
      suiteDigest: promoted.suiteDigest,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt
    }).pipe(Effect.mapError((cause) => handoffError("normalizing measured evidence", cause)));
    const policy = yield* Effect.try({
      try: () => compileRoutingPolicy(input.profile, comparison),
      catch: (cause) => handoffError("compiling the routing policy", cause)
    });
    const snapshot = yield* makeRoutingSnapshotStore(input.snapshotRoot)
      .publish(policy)
      .pipe(
        Effect.provide(NodeServicesLayer),
        Effect.mapError((cause) => handoffError("publishing the routing snapshot", cause))
      );
    return { ...promoted, comparison, policy, snapshot };
  });
