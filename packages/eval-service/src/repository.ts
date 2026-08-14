import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import {
  StoredEvalObservations,
  type StoredEvalRun,
  StoredEvalRun as StoredEvalRunSchema
} from "@velum-labs/routekit-eval-contracts";
import { randomId } from "@velum-labs/routekit-runtime";
import { writeFileAtomicEffect } from "@velum-labs/routekit-runtime/effect";
import { Context, Data, Effect, FileSystem, Layer, Path, Schema } from "effect";

export class EvalRepositoryError extends Data.TaggedError("EvalRepositoryError")<{
  readonly operation: "list" | "read" | "write";
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Could not ${this.operation} evaluation evidence at ${this.path}.`;
  }
}

export class EvalRunImmutableError extends Data.TaggedError("EvalRunImmutableError")<{
  readonly runId: string;
}> {
  override get message(): string {
    return `Evaluation run ${this.runId} is immutable and already exists.`;
  }
}

/**
 * Run IDs are path segments, not paths. Generated IDs use `eval_<16 hex>`;
 * explicitly imported evidence uses `import_<safe-slug>`.
 */
export class InvalidEvalRunIdError extends Data.TaggedError("InvalidEvalRunIdError")<{
  readonly runId: string;
}> {
  override get message(): string {
    return `Invalid evaluation run id ${JSON.stringify(this.runId)}.`;
  }
}

const GENERATED_RUN_ID = /^eval_[0-9a-f]{16}$/u;
const IMPORTED_RUN_ID = /^import_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u;

export const isValidEvalRunId = (runId: string): boolean =>
  GENERATED_RUN_ID.test(runId) || IMPORTED_RUN_ID.test(runId);

export const validateEvalRunId = (runId: string): Effect.Effect<string, InvalidEvalRunIdError> =>
  isValidEvalRunId(runId)
    ? Effect.succeed(runId)
    : Effect.fail(new InvalidEvalRunIdError({ runId }));

export type EvalRepositoryFailure =
  | EvalRepositoryError
  | EvalRunImmutableError
  | InvalidEvalRunIdError;

export type EvalRepositoryReadFailure = EvalRepositoryError | InvalidEvalRunIdError;

export interface PersistedEvalRun {
  readonly runDirectory: string;
  readonly rawPath: string;
  readonly observationsPath: string;
}

export interface EvalRepositoryService {
  readonly save: (
    run: StoredEvalRun,
    observations: StoredEvalObservations
  ) => Effect.Effect<PersistedEvalRun, EvalRepositoryFailure>;
  readonly readRun: (
    runId: string
  ) => Effect.Effect<StoredEvalRun | undefined, EvalRepositoryReadFailure>;
  readonly readObservations: (
    runId: string
  ) => Effect.Effect<StoredEvalObservations | undefined, EvalRepositoryReadFailure>;
  readonly listRunIds: Effect.Effect<readonly string[], EvalRepositoryError>;
}

export class EvalRepository extends Context.Service<EvalRepository, EvalRepositoryService>()(
  "@velum-labs/routekit-eval-service/EvalRepository"
) {}

const provideNode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(nodeServicesLayer));

const repositoryFailure =
  (operation: EvalRepositoryError["operation"], path: string) => (cause: unknown) =>
    new EvalRepositoryError({ operation, path, cause });

const preserveRepositoryFailure =
  (operation: EvalRepositoryError["operation"], path: string) => (cause: unknown) =>
    cause instanceof EvalRepositoryError || cause instanceof InvalidEvalRunIdError
      ? cause
      : repositoryFailure(operation, path)(cause);

const readJson = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path))) return undefined;
    const source = yield* fs.readFileString(path);
    return yield* Effect.try({
      try: () => JSON.parse(source) as unknown,
      catch: (cause) => new EvalRepositoryError({ operation: "read", path, cause })
    });
  });

export const makeEvalRepositoryLayer = (options: {
  readonly root: string;
}): Layer.Layer<EvalRepository> => {
  const save: EvalRepositoryService["save"] = (run, observations) =>
    provideNode(
      Effect.gen(function* () {
        const runId = yield* validateEvalRunId(run.manifest.runId);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runsRoot = path.join(options.root, "runs");
        const runDirectory = path.join(runsRoot, runId);
        if (yield* fs.exists(runDirectory)) {
          return yield* new EvalRunImmutableError({ runId });
        }

        yield* fs.makeDirectory(runsRoot, { recursive: true, mode: 0o700 });
        yield* fs.chmod(options.root, 0o700);
        yield* fs.chmod(runsRoot, 0o700);
        const staging = path.join(runsRoot, `.${runId}.${randomId(8)}.tmp`);
        const rawPath = path.join(staging, "raw.json");
        const observationsPath = path.join(staging, "observations.json");

        yield* Effect.ensuring(
          Effect.gen(function* () {
            yield* fs.makeDirectory(staging, { mode: 0o700 });
            yield* writeFileAtomicEffect(rawPath, `${JSON.stringify(run, null, 2)}\n`, {
              mode: 0o600
            });
            yield* writeFileAtomicEffect(
              observationsPath,
              `${JSON.stringify(observations, null, 2)}\n`,
              { mode: 0o600 }
            );
            yield* fs.rename(staging, runDirectory);
          }),
          fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)
        );

        return {
          runDirectory,
          rawPath: path.join(runDirectory, "raw.json"),
          observationsPath: path.join(runDirectory, "observations.json")
        };
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof EvalRunImmutableError || cause instanceof InvalidEvalRunIdError
            ? cause
            : repositoryFailure("write", options.root)(cause)
        )
      )
    );

  const readRun: EvalRepositoryService["readRun"] = (runId) =>
    provideNode(
      Effect.gen(function* () {
        const validRunId = yield* validateEvalRunId(runId);
        const path = yield* Path.Path;
        const file = path.join(options.root, "runs", validRunId, "raw.json");
        const value = yield* readJson(file);
        if (value === undefined) return undefined;
        return yield* Schema.decodeUnknownEffect(StoredEvalRunSchema)(value);
      }).pipe(Effect.mapError(preserveRepositoryFailure("read", runId)))
    );

  const readObservations: EvalRepositoryService["readObservations"] = (runId) =>
    provideNode(
      Effect.gen(function* () {
        const validRunId = yield* validateEvalRunId(runId);
        const path = yield* Path.Path;
        const file = path.join(options.root, "runs", validRunId, "observations.json");
        const value = yield* readJson(file);
        if (value === undefined) return undefined;
        return yield* Schema.decodeUnknownEffect(StoredEvalObservations)(value);
      }).pipe(Effect.mapError(preserveRepositoryFailure("read", runId)))
    );

  const listRunIds: EvalRepositoryService["listRunIds"] = provideNode(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runsRoot = path.join(options.root, "runs");
      if (!(yield* fs.exists(runsRoot))) return [];
      return (yield* fs.readDirectory(runsRoot))
        .filter(isValidEvalRunId)
        .sort((left, right) => left.localeCompare(right));
    }).pipe(Effect.mapError(repositoryFailure("list", options.root)))
  );

  return Layer.succeed(EvalRepository)({
    save,
    readRun,
    readObservations,
    listRunIds
  });
};
