import { createHash } from "node:crypto";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import type {
  EvalComparisonCase,
  EvalComparisonRequest,
  EvalComparisonResult,
  EvalModelComparison
} from "@velum-labs/routekit-eval-contracts";
import { Clock, Context, Crypto, Data, Effect, FileSystem, Layer, Option, Path } from "effect";
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

const EVAL_SUFFIX = ".eval.ts";
const FORBIDDEN_MODELS = new Set(["auto", "router", "default"]);
const EXPLICIT_MODEL = /^[^/\s]+\/[^/\s]+$/u;

const provideNode = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Crypto.Crypto | FileSystem.FileSystem | Path.Path>> =>
  effect.pipe(Effect.provide(NodeServicesLayer)) as Effect.Effect<
    A,
    E,
    Exclude<R, Crypto.Crypto | FileSystem.FileSystem | Path.Path>
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
    EvalEngineDiscoveryError | EvalEnginePortableImportError
  >;
  readonly runComparison: (
    request: EvalComparisonRequest
  ) => Effect.Effect<
    EvalComparisonResult,
    | EvalEngineDiscoveryError
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
            return {
              version: 1,
              comparisonId,
              profileId: request.profileId,
              suiteDigest: discovery.suiteDigest,
              judgeModel: request.judgeModel,
              startedAt,
              finishedAt: new Date(yield* clock.currentTimeMillis).toISOString(),
              models: normalizeComparison({ request, output })
            } satisfies EvalComparisonResult;
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
  EvalEngineDiscoveryError | EvalEnginePortableImportError,
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
  | EvalEngineExecutionError
  | EvalEngineInvalidRequestError
  | EvalEnginePortableImportError,
  EvalEngine
> =>
  Effect.gen(function* () {
    return yield* (yield* EvalEngine).runComparison(request);
  });
