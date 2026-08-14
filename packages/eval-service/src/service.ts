import { createHash } from "node:crypto";
import {
  EVAL_CONTRACT_VERSION,
  type EvalEvaluatorMetadata,
  type EvalRunManifest,
  type InvalidEvalModelError,
  type NormalizedEvalObservation,
  type StoredEvalRun,
  validateExplicitEvalModel
} from "@velum-labs/routekit-eval-contracts";
import {
  discoverEvals,
  dryRunEvals,
  type EvalDiscovery,
  type EvalEngineError,
  type EvalEngineEvent,
  type EvalRunSummary,
  listEvals,
  makeEvalEngineLayer,
  runEvals
} from "@velum-labs/routekit-eval-engine";
import { randomId } from "@velum-labs/routekit-runtime";
import { Clock, Context, Data, Effect, FileSystem, Layer, Path, Stream } from "effect";

import { materializeOriSdk, provideNodeOriSdk } from "./ori-sdk.js";
import {
  EvalRepository,
  type EvalRepositoryError,
  type EvalRepositoryFailure,
  type EvalRepositoryReadFailure,
  makeEvalRepositoryLayer,
  type PersistedEvalRun
} from "./repository.js";

const AUTHOR_RUNTIME: EvalEvaluatorMetadata = {
  kind: "engine",
  name: "routekit-ori-eval-subset",
  version: "1"
};

export interface EvalWorkload {
  readonly workloadId: string;
  readonly candidateModel: string;
  readonly judgeModel: string;
  readonly suiteId?: string;
  readonly inventoryFingerprint?: string;
}

export interface EvalPathOptions {
  readonly target: string;
  readonly workingDirectory?: string;
}

export interface EvalExecutionInput extends EvalPathOptions {
  readonly workload: EvalWorkload;
  readonly timeoutMs?: number;
}

export interface EvalServiceConfig {
  readonly repositoryRoot: string;
  readonly nodeExecutable: string;
  readonly gatewayUrl: string;
  readonly gatewayToken: string;
  readonly engineVersion?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly defaultTimeoutMs?: number;
}

export class EvalServiceError extends Data.TaggedError("EvalServiceError")<{
  readonly operation: "materialize" | "suite-digest";
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Could not ${this.operation.replace("-", " ")} for the evaluation run.`;
  }
}

export type EvalApplicationError =
  | EvalEngineError
  | EvalRepositoryFailure
  | EvalServiceError
  | InvalidEvalModelError;

export type EvalServiceEvent =
  | { readonly _tag: "EvalDiscovered"; readonly discovery: EvalDiscovery }
  | {
      readonly _tag: "EvalRunStarted";
      readonly runId: string;
      readonly files: readonly string[];
      readonly dryRun: boolean;
    }
  | {
      readonly _tag: "EvalDryRunCompleted";
      readonly runId: string;
      readonly fileCount: number;
      readonly durationMs: number;
    }
  | {
      readonly _tag: "EvalRunCompleted";
      readonly run: StoredEvalRun;
      readonly observations: readonly NormalizedEvalObservation[];
      readonly persisted: PersistedEvalRun;
    };

export interface EvalServiceApi {
  readonly discover: (options: EvalPathOptions) => Effect.Effect<EvalDiscovery, EvalEngineError>;
  readonly list: (options: EvalPathOptions) => Effect.Effect<readonly string[], EvalEngineError>;
  readonly dryRun: (
    input: EvalExecutionInput
  ) => Stream.Stream<EvalServiceEvent, EvalApplicationError>;
  readonly run: (
    input: EvalExecutionInput
  ) => Stream.Stream<EvalServiceEvent, EvalApplicationError>;
  readonly readRun: (
    runId: string
  ) => Effect.Effect<StoredEvalRun | undefined, EvalRepositoryReadFailure>;
  readonly readObservations: (
    runId: string
  ) => Effect.Effect<readonly NormalizedEvalObservation[] | undefined, EvalRepositoryReadFailure>;
  readonly listRunIds: Effect.Effect<readonly string[], EvalRepositoryError>;
}

export class EvalService extends Context.Service<EvalService, EvalServiceApi>()(
  "@velum-labs/routekit-eval-service/EvalService"
) {}

const suiteDigest = (
  discovery: EvalDiscovery
): Effect.Effect<string, EvalServiceError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hash = createHash("sha256");
    for (const file of discovery.files) {
      hash.update(path.relative(discovery.workingDirectory, file));
      hash.update("\0");
      hash.update(yield* fs.readFile(file));
      hash.update("\0");
    }
    return hash.digest("hex");
  }).pipe(Effect.mapError((cause) => new EvalServiceError({ operation: "suite-digest", cause })));

const normalize = (
  manifest: EvalRunManifest,
  summary: EvalRunSummary
): readonly NormalizedEvalObservation[] =>
  summary.results.map((result) => {
    const role = result.role ?? "candidate";
    return {
      version: EVAL_CONTRACT_VERSION,
      runId: manifest.runId,
      ...(result.caseId === undefined ? {} : { caseId: result.caseId }),
      suiteId: manifest.suiteId,
      suiteDigest: manifest.suiteDigest,
      workloadId: manifest.workloadId,
      candidateModel: manifest.candidateModel,
      judgeModel: manifest.judgeModel,
      engineVersion: manifest.engineVersion,
      ...(manifest.inventoryFingerprint === undefined
        ? {}
        : { inventoryFingerprint: manifest.inventoryFingerprint }),
      role,
      model: result.terminal?.model ?? result.model,
      outcome: result.outcome,
      ...(result.score === undefined ? {} : { score: result.score }),
      cutOff: result.cutOff,
      ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      evaluator:
        role === "judge"
          ? { kind: "llm-judge", name: "ori-autoEvals", version: "1" }
          : { kind: "assertion", name: "ori-run-assertions", version: "1" },
      ...(result.outcomeDetail === undefined ? {} : { outcomeDetail: result.outcomeDetail })
    } satisfies NormalizedEvalObservation;
  });

const validateWorkload = (workload: EvalWorkload) =>
  Effect.all([
    validateExplicitEvalModel(workload.candidateModel, "candidate"),
    validateExplicitEvalModel(workload.judgeModel, "judge")
  ]);

const serviceError = (operation: EvalServiceError["operation"]) => (cause: unknown) =>
  new EvalServiceError({ operation, cause });

export const makeEvalServiceLayer = (config: EvalServiceConfig): Layer.Layer<EvalService> => {
  const engineLayer = makeEvalEngineLayer({
    nodeExecutable: config.nodeExecutable,
    environment: config.environment,
    ...(config.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: config.defaultTimeoutMs })
  });
  const repositoryLayer = makeEvalRepositoryLayer({ root: config.repositoryRoot });
  const repositoryEffect = Effect.service(EvalRepository).pipe(Effect.provide(repositoryLayer));

  const discover: EvalServiceApi["discover"] = (options) =>
    discoverEvals(options).pipe(Effect.provide(engineLayer));
  const list: EvalServiceApi["list"] = (options) =>
    listEvals(options).pipe(Effect.provide(engineLayer));

  const execute = (
    input: EvalExecutionInput,
    dryRun: boolean
  ): Stream.Stream<EvalServiceEvent, EvalApplicationError> =>
    Stream.unwrap(
      provideNodeOriSdk(
        Effect.gen(function* () {
          yield* validateWorkload(input.workload);
          const discovery = yield* discover(input);
          const digest = yield* suiteDigest(discovery);
          const runId = `eval_${randomId(16)}`;
          const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          const sdk = yield* materializeOriSdk.pipe(Effect.mapError(serviceError("materialize")));
          const nodeOptions = [config.environment?.NODE_OPTIONS, sdk.nodeOptionsImport]
            .filter((value): value is string => value !== undefined && value.length > 0)
            .join(" ");
          const environment = {
            ...(config.environment ?? {}),
            NODE_OPTIONS: nodeOptions,
            ROUTEKIT_EVAL_GATEWAY_URL: config.gatewayUrl,
            ROUTEKIT_EVAL_GATEWAY_TOKEN: config.gatewayToken,
            ROUTEKIT_EVAL_RUN_ID: runId,
            ROUTEKIT_EVAL_WORKLOAD_ID: input.workload.workloadId,
            ROUTEKIT_EVAL_SUITE_ID: input.workload.suiteId ?? input.workload.workloadId,
            ROUTEKIT_EVAL_CANDIDATE_MODEL: input.workload.candidateModel,
            ROUTEKIT_EVAL_JUDGE_MODEL: input.workload.judgeModel
          };
          const engineStream = (
            dryRun
              ? dryRunEvals({
                  target: input.target,
                  ...(input.workingDirectory === undefined
                    ? {}
                    : { workingDirectory: input.workingDirectory }),
                  environment,
                  ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
                })
              : runEvals({
                  target: input.target,
                  ...(input.workingDirectory === undefined
                    ? {}
                    : { workingDirectory: input.workingDirectory }),
                  environment,
                  ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
                })
          ).pipe(Stream.provide(engineLayer));
          const removeSdk = provideNodeOriSdk(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              yield* fs.remove(sdk.directory, { recursive: true, force: true });
            })
          ).pipe(Effect.ignore);

          return engineStream.pipe(
            Stream.mapEffect(
              (event: EvalEngineEvent): Effect.Effect<EvalServiceEvent, EvalRepositoryFailure> => {
                if (event._tag === "EvalDiscovered") {
                  return Effect.succeed({
                    _tag: "EvalDiscovered",
                    discovery: event.discovery
                  } as const);
                }
                if (event._tag === "EvalRunStarted") {
                  return Effect.succeed({
                    _tag: "EvalRunStarted",
                    runId,
                    files: event.files,
                    dryRun: event.dryRun
                  } as const);
                }
                if (event._tag === "EvalDryRunCompleted") {
                  return Effect.succeed({
                    _tag: "EvalDryRunCompleted",
                    runId,
                    fileCount: event.summary.fileCount,
                    durationMs: event.summary.durationMs
                  } as const);
                }
                const persist = Effect.gen(function* () {
                  const manifest: EvalRunManifest = {
                    version: EVAL_CONTRACT_VERSION,
                    runId,
                    suiteId: input.workload.suiteId ?? input.workload.workloadId,
                    suiteDigest: digest,
                    workloadId: input.workload.workloadId,
                    candidateModel: input.workload.candidateModel,
                    judgeModel: input.workload.judgeModel,
                    engineVersion: config.engineVersion ?? "ori-node-test-v1",
                    ...(input.workload.inventoryFingerprint === undefined
                      ? {}
                      : { inventoryFingerprint: input.workload.inventoryFingerprint }),
                    startedAt,
                    finishedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
                    evaluator: AUTHOR_RUNTIME
                  };
                  const run: StoredEvalRun = {
                    version: EVAL_CONTRACT_VERSION,
                    manifest,
                    engine: event.summary
                  };
                  const observations = normalize(manifest, event.summary);
                  const repository = yield* repositoryEffect;
                  const persisted = yield* repository.save(run, {
                    version: EVAL_CONTRACT_VERSION,
                    runId,
                    observations
                  });
                  return {
                    _tag: "EvalRunCompleted",
                    run,
                    observations,
                    persisted
                  } as const;
                });
                return persist;
              }
            ),
            Stream.ensuring(removeSdk)
          );
        })
      )
    );

  const readRun: EvalServiceApi["readRun"] = (runId) =>
    repositoryEffect.pipe(Effect.flatMap((repository) => repository.readRun(runId)));
  const readObservations: EvalServiceApi["readObservations"] = (runId) =>
    repositoryEffect.pipe(
      Effect.flatMap((repository) => repository.readObservations(runId)),
      Effect.map((document) => document?.observations)
    );
  const listRunIds: EvalServiceApi["listRunIds"] = repositoryEffect.pipe(
    Effect.flatMap((repository) => repository.listRunIds)
  );

  return Layer.succeed(EvalService)({
    discover,
    list,
    dryRun: (input) => execute(input, true),
    run: (input) => execute(input, false),
    readRun,
    readObservations,
    listRunIds
  });
};

export const discoverEvalPath = (
  options: EvalPathOptions
): Effect.Effect<EvalDiscovery, EvalEngineError, EvalService> =>
  Effect.gen(function* () {
    const service = yield* EvalService;
    return yield* service.discover(options);
  });

export const listEvalPath = (
  options: EvalPathOptions
): Effect.Effect<readonly string[], EvalEngineError, EvalService> =>
  Effect.gen(function* () {
    const service = yield* EvalService;
    return yield* service.list(options);
  });

export const dryRunEvalPath = (
  input: EvalExecutionInput
): Stream.Stream<EvalServiceEvent, EvalApplicationError, EvalService> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const service = yield* EvalService;
      return service.dryRun(input);
    })
  );

export const runEvalPath = (
  input: EvalExecutionInput
): Stream.Stream<EvalServiceEvent, EvalApplicationError, EvalService> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const service = yield* EvalService;
      return service.run(input);
    })
  );
