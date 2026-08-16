import { createHash } from "node:crypto";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import type {
  EvalComparisonCase,
  EvalComparisonRequest,
  EvalComparisonResult,
  EvalModelComparison
} from "@velum-labs/routekit-eval-contracts";
import { Clock, Context, Crypto, Data, Effect, FileSystem, Layer, Option, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { discoverEvalFiles } from "../vendor/framework/cli/src/commands/eval/discover.ts";
import type { EvalTestRow } from "../vendor/framework/cli/src/commands/eval/junit.ts";
import { nonPortableImportSpecifiers } from "../vendor/framework/cli/src/commands/eval/portable-imports.ts";
import type { EvalResultRow } from "../vendor/framework/cli/src/commands/eval/results.ts";
import {
  isCandidateRun,
  rowCostUsd,
  runErrorText,
  runModel
} from "../vendor/framework/cli/src/commands/eval/results.ts";
import { dryLoadEvals, type EvalEngineDryLoadError } from "./dry-load.ts";

const EVAL_SUFFIX = ".eval.ts";
const FORBIDDEN_MODELS = new Set(["auto", "router", "default"]);
const EXPLICIT_MODEL = /^[^/\s]+\/[^/\s]+$/u;

const provideNode = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  E,
  Exclude<
    R,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >
> =>
  effect.pipe(Effect.provide(NodeServicesLayer)) as Effect.Effect<
    A,
    E,
    Exclude<
      R,
      ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
    >
  >;

export interface EvalEngineDiscovery {
  readonly searchRoot: string;
  readonly workingDirectory: string;
  readonly files: readonly string[];
}

export interface EvalEngineValidation extends EvalEngineDiscovery {
  readonly suiteDigest: string;
}

export class EvalEngineDiscoveryError extends Data.TaggedError("EvalEngineDiscoveryError")<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Could not discover RouteKit Eval files under ${this.path}.`;
  }
}

export class EvalEnginePortableImportError extends Data.TaggedError(
  "EvalEnginePortableImportError"
)<{
  readonly offences: readonly string[];
}> {
  override get message(): string {
    return `RouteKit Eval files contain non-portable imports:\n${this.offences.join("\n")}`;
  }
}

export class EvalEngineInvalidRequestError extends Data.TaggedError(
  "EvalEngineInvalidRequestError"
)<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

export class EvalEngineExecutionError extends Data.TaggedError("EvalEngineExecutionError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

export interface EvalExecutionOutput {
  readonly results: readonly EvalResultRow[];
  readonly tests: readonly EvalTestRow[];
}

export interface EvalComparisonEvidence {
  readonly comparisonId: string;
  readonly request: EvalComparisonRequest;
  readonly output: EvalExecutionOutput;
  readonly suiteDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface EvalExecutionModels {
  readonly candidateModels: readonly string[];
  readonly judgeModels: readonly string[];
}

const distinct = (values: readonly string[]): readonly string[] => [...new Set(values)];

/** Read observed model roles from Ori's structured eval rows without parsing reports. */
export const evalExecutionModels = (output: EvalExecutionOutput): EvalExecutionModels => ({
  candidateModels: distinct(output.results.filter(isCandidateRun).map(runModel)),
  judgeModels: distinct(output.results.filter((row) => !isCandidateRun(row)).map(runModel))
});

export interface EvalExecutionPortService {
  readonly execute: (input: {
    readonly comparisonId: string;
    readonly discovery: EvalEngineDiscovery;
    readonly request: EvalComparisonRequest;
  }) => Effect.Effect<EvalExecutionOutput, EvalEngineExecutionError>;
}

/**
 * Injectable execution boundary for RouteKit Eval.
 *
 * Implementations return the engine's real JUnit/JSONL rows and must not invoke
 * the standalone executable. The package's concrete implementation uses a
 * scoped loopback gateway bridge plus a scoped `node --test` child.
 */
export class EvalExecutionPort extends Context.Service<
  EvalExecutionPort,
  EvalExecutionPortService
>()("@velum-labs/routekit-eval-engine/EvalExecutionPort") {}

export interface EvalEngineService {
  readonly discover: (
    target: string
  ) => Effect.Effect<EvalEngineDiscovery, EvalEngineDiscoveryError>;
  readonly validate: (
    target: string
  ) => Effect.Effect<
    EvalEngineValidation,
    EvalEngineDiscoveryError | EvalEngineDryLoadError | EvalEnginePortableImportError
  >;
  readonly runComparison: (
    request: EvalComparisonRequest
  ) => Effect.Effect<
    EvalComparisonResult,
    | EvalEngineDiscoveryError
    | EvalEngineDryLoadError
    | EvalEngineExecutionError
    | EvalEngineInvalidRequestError
    | EvalEnginePortableImportError
  >;
}

export class EvalEngine extends Context.Service<EvalEngine, EvalEngineService>()(
  "@velum-labs/routekit-eval-engine/EvalEngine"
) {}

const isExplicitModel = (model: string): boolean => {
  const normalized = model.trim().toLowerCase();
  return normalized.length > 0 && !FORBIDDEN_MODELS.has(normalized) && EXPLICIT_MODEL.test(model);
};

const validateRequest = (
  request: EvalComparisonRequest
): Effect.Effect<void, EvalEngineInvalidRequestError> =>
  Effect.gen(function* () {
    if (request.profileId.trim().length === 0) {
      return yield* new EvalEngineInvalidRequestError({
        detail: "RouteKit Eval comparison profileId must not be empty."
      });
    }
    if (request.candidateModels.length === 0) {
      return yield* new EvalEngineInvalidRequestError({
        detail: "RouteKit Eval comparison requires at least one candidate model."
      });
    }
    const seen = new Set<string>();
    for (const model of request.candidateModels) {
      if (!isExplicitModel(model)) {
        return yield* new EvalEngineInvalidRequestError({
          detail: `Candidate model must be an explicit provider/model id, not ${JSON.stringify(model)}.`
        });
      }
      if (seen.has(model)) {
        return yield* new EvalEngineInvalidRequestError({
          detail: `Duplicate candidate model ${JSON.stringify(model)}.`
        });
      }
      seen.add(model);
    }
    if (!isExplicitModel(request.judgeModel)) {
      return yield* new EvalEngineInvalidRequestError({
        detail: `Judge model must be an explicit provider/model id, not ${JSON.stringify(request.judgeModel)}.`
      });
    }
    if (request.timeoutMs !== undefined && request.timeoutMs < 1) {
      return yield* new EvalEngineInvalidRequestError({
        detail: "RouteKit Eval timeoutMs must be at least 1."
      });
    }
    if (request.concurrency !== undefined && request.concurrency < 1) {
      return yield* new EvalEngineInvalidRequestError({
        detail: "RouteKit Eval concurrency must be at least 1."
      });
    }
    if (request.spendLimitUsd !== undefined && request.spendLimitUsd < 0) {
      return yield* new EvalEngineInvalidRequestError({
        detail: "RouteKit Eval spendLimitUsd must be non-negative."
      });
    }
  });

const resolveTarget = Effect.fn("EvalEngine.resolveTarget")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(target);
  const info = yield* fs
    .stat(resolved)
    .pipe(Effect.mapError((cause) => new EvalEngineDiscoveryError({ path: resolved, cause })));
  if (info.type === "File" && !resolved.endsWith(EVAL_SUFFIX)) {
    return yield* new EvalEngineDiscoveryError({
      path: resolved,
      cause: new Error(`Expected a ${EVAL_SUFFIX} file or a directory.`)
    });
  }
  return {
    searchRoot: resolved,
    workingDirectory: info.type === "File" ? path.dirname(resolved) : resolved
  };
});

const discover = Effect.fn("EvalEngine.discover")(function* (target: string) {
  const resolved = yield* resolveTarget(target);
  const files = yield* discoverEvalFiles(resolved.searchRoot).pipe(
    Effect.mapError(
      (cause) =>
        new EvalEngineDiscoveryError({
          path: resolved.searchRoot,
          cause
        })
    )
  );
  return { ...resolved, files } satisfies EvalEngineDiscovery;
});

const portableOffences = Effect.fn("EvalEngine.portableOffences")(function* (
  files: readonly string[]
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = path.resolve();
  return (yield* Effect.forEach(
    files,
    (file) =>
      fs.readFileString(file).pipe(
        Effect.mapError((cause) => new EvalEngineDiscoveryError({ path: file, cause })),
        Effect.map((source) =>
          nonPortableImportSpecifiers(source).map(
            (specifier) => `${path.relative(base, file)} -> ${specifier}`
          )
        )
      ),
    { concurrency: "unbounded" }
  )).flat();
});

const validate = Effect.fn("EvalEngine.validate")(function* (target: string) {
  const discovered = yield* discover(target);
  const offences = yield* portableOffences(discovered.files);
  if (offences.length > 0) {
    return yield* new EvalEnginePortableImportError({ offences });
  }
  yield* dryLoadEvals(discovered);
  const fs = yield* FileSystem.FileSystem;
  const hash = createHash("sha256");
  for (const file of discovered.files) {
    hash.update(file);
    hash.update("\0");
    hash.update(
      yield* fs
        .readFile(file)
        .pipe(Effect.mapError((cause) => new EvalEngineDiscoveryError({ path: file, cause })))
    );
    hash.update("\0");
  }
  return {
    ...discovered,
    suiteDigest: hash.digest("hex")
  } satisfies EvalEngineValidation;
});

const usageNumbers = (
  row: EvalResultRow
): {
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
} => {
  const payload = row.terminal?.payload;
  if (payload === null || typeof payload !== "object") return {};
  const usage = (payload as { readonly usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return {};
  const record = usage as Readonly<Record<string, unknown>>;
  return {
    ...(typeof record.costUsd === "number" ? { costUsd: record.costUsd } : {}),
    ...(typeof record.inputTokens === "number" ? { inputTokens: record.inputTokens } : {}),
    ...(typeof record.outputTokens === "number" ? { outputTokens: record.outputTokens } : {})
  };
};

const toComparisonCase = (row: EvalResultRow, caseId: string): EvalComparisonCase => {
  const usage = usageNumbers(row);
  const costUsd = rowCostUsd(row);
  const error = Option.getOrUndefined(runErrorText(row)) ?? row.outcomeDetail;
  return {
    caseId,
    outcome: row.cutOff ? "cutoff" : row.outcome,
    measurement: {
      ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
      ...(row.score === undefined ? {} : { judgeScore: row.score }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens })
    },
    ...(error === undefined ? {} : { error })
  };
};

const normalizeComparison = (input: {
  readonly request: EvalComparisonRequest;
  readonly output: EvalExecutionOutput;
}): readonly EvalModelComparison[] => {
  const candidateRows = input.output.results.filter(isCandidateRun);
  // The current JSONL rows do not carry a case id. Preserve the child process'
  // row order and pair it with node:test's JUnit order before grouping by model;
  // indexing independently inside each model would incorrectly reuse the first
  // test name for every model.
  const indexed = candidateRows.map((row, index) => ({
    row,
    caseId: input.output.tests[index]?.name ?? `${input.request.profileId}:${index + 1}`
  }));
  return input.request.candidateModels.map((model) => {
    const rows = indexed.filter(({ row }) => runModel(row) === model);
    return {
      model,
      cases: rows.map(({ row, caseId }) => toComparisonCase(row, caseId))
    };
  });
};

/**
 * Fail closed when authored eval code did not actually execute the comparison
 * requested by RouteKit.
 *
 * Candidate models currently live in authored eval source rather than being
 * injected into the generated SDK. That means the execution boundary cannot
 * make an arbitrary suite run a newly requested model. It can, however, refuse
 * to turn a partial or mismatched run into a routing policy: every requested
 * candidate must have at least one crash-tolerant row (including a cutoff row),
 * and every candidate/judge row must retain its requested role and model.
 */
const validateExecutionEvidence = (
  request: EvalComparisonRequest,
  output: EvalExecutionOutput
): Effect.Effect<void, EvalEngineExecutionError> =>
  Effect.gen(function* () {
    const requestedCandidates = new Set(request.candidateModels);
    const candidateModels = output.results.filter(isCandidateRun).map(runModel);
    const unexpectedCandidates = [
      ...new Set(candidateModels.filter((model) => !requestedCandidates.has(model)))
    ].sort();
    if (unexpectedCandidates.length > 0) {
      return yield* new EvalEngineExecutionError({
        cause: new Error("unrequested candidate evidence"),
        detail: `RouteKit Eval produced evidence for unrequested candidate model(s): ${unexpectedCandidates.join(", ")}.`
      });
    }

    const observedCandidates = new Set(candidateModels);
    const missingCandidates = request.candidateModels.filter(
      (model) => !observedCandidates.has(model)
    );
    if (missingCandidates.length > 0) {
      return yield* new EvalEngineExecutionError({
        cause: new Error("missing requested candidate evidence"),
        detail: `RouteKit Eval produced no cases for requested candidate model(s): ${missingCandidates.join(", ")}. Ensure the authored suite executes every configured candidate.`
      });
    }

    const unexpectedJudges = [
      ...new Set(
        output.results
          .filter((row) => !isCandidateRun(row))
          .map(runModel)
          .filter((model) => model !== request.judgeModel)
      )
    ].sort();
    if (unexpectedJudges.length > 0) {
      return yield* new EvalEngineExecutionError({
        cause: new Error("unexpected judge evidence"),
        detail: `RouteKit Eval produced judge evidence for model(s) other than ${request.judgeModel}: ${unexpectedJudges.join(", ")}.`
      });
    }
  });

/**
 * Normalize an already-measured Ori eval run into RouteKit policy evidence.
 *
 * This is the non-executing handoff used by authoring workflows: it applies
 * the same fail-closed model/role checks as `runComparison` without paying to
 * run the suite a second time.
 */
export const normalizeEvalComparisonEvidence = (
  input: EvalComparisonEvidence
): Effect.Effect<
  EvalComparisonResult,
  EvalEngineExecutionError | EvalEngineInvalidRequestError
> =>
  Effect.gen(function* () {
    yield* validateRequest(input.request);
    if (input.comparisonId.trim().length === 0) {
      return yield* new EvalEngineInvalidRequestError({
        detail: "RouteKit Eval comparisonId must not be empty."
      });
    }
    if (input.suiteDigest.trim().length === 0) {
      return yield* new EvalEngineInvalidRequestError({
        detail: "RouteKit Eval suiteDigest must not be empty."
      });
    }
    yield* validateExecutionEvidence(input.request, input.output);
    return {
      version: 1,
      comparisonId: input.comparisonId,
      profileId: input.request.profileId,
      suiteDigest: input.suiteDigest,
      judgeModel: input.request.judgeModel,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      models: normalizeComparison({ request: input.request, output: input.output })
    };
  });

export const makeEvalEngineLayer = (execution: EvalExecutionPortService): Layer.Layer<EvalEngine> =>
  Layer.succeed(
    EvalEngine,
    EvalEngine.of({
      discover: (target) => provideNode(discover(target)),
      validate: (target) => provideNode(validate(target)),
      runComparison: (request) =>
        provideNode(
          Effect.gen(function* () {
            yield* validateRequest(request);
            const clock = yield* Clock.Clock;
            const crypto = yield* Crypto.Crypto;
            const startedAt = new Date(yield* clock.currentTimeMillis).toISOString();
            const comparisonId = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(
                (cause) =>
                  new EvalEngineExecutionError({
                    cause,
                    detail: "Could not create a RouteKit Eval comparison id."
                  })
              )
            );
            const discovery = yield* validate(request.suitePath);
            const output = yield* execution.execute({
              comparisonId,
              discovery,
              request
            });
            return yield* normalizeEvalComparisonEvidence({
              comparisonId,
              request,
              output,
              suiteDigest: discovery.suiteDigest,
              startedAt,
              finishedAt: new Date(yield* clock.currentTimeMillis).toISOString()
            });
          })
        )
    })
  );

export const discoverEvals = (
  target: string
): Effect.Effect<EvalEngineDiscovery, EvalEngineDiscoveryError, EvalEngine> =>
  Effect.gen(function* () {
    return yield* (yield* EvalEngine).discover(target);
  });

export const validateEvals = (
  target: string
): Effect.Effect<
  EvalEngineValidation,
  EvalEngineDiscoveryError | EvalEngineDryLoadError | EvalEnginePortableImportError,
  EvalEngine
> =>
  Effect.gen(function* () {
    return yield* (yield* EvalEngine).validate(target);
  });

export const runEvalComparison = (
  request: EvalComparisonRequest
): Effect.Effect<
  EvalComparisonResult,
  | EvalEngineDiscoveryError
  | EvalEngineDryLoadError
  | EvalEngineExecutionError
  | EvalEngineInvalidRequestError
  | EvalEnginePortableImportError,
  EvalEngine
> =>
  Effect.gen(function* () {
    return yield* (yield* EvalEngine).runComparison(request);
  });
