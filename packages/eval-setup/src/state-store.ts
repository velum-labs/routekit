import {
  CompiledRoutingPolicy,
  EVAL_SETUP_VERSION,
  EvalComparisonResult,
  type EvalSetupState,
  EvalSetupState as EvalSetupStateSchema
} from "@velum-labs/routekit-eval-contracts";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

import { EvalSetupStateError } from "./errors.js";
import type { EvalSetupRunCheckpoint } from "./types.js";

const EvalSetupRunCheckpointSchema = Schema.Struct({
  comparison: EvalComparisonResult,
  proposal: CompiledRoutingPolicy
});

export type EvalSetupStateStoreShape = {
  readonly load: (
    repositoryRoot: string,
    profileId: string
  ) => Effect.Effect<EvalSetupState | undefined, EvalSetupStateError>;
  readonly save: (state: EvalSetupState) => Effect.Effect<void, EvalSetupStateError>;
  readonly loadRun: (
    repositoryRoot: string,
    profileId: string
  ) => Effect.Effect<EvalSetupRunCheckpoint | undefined, EvalSetupStateError>;
  readonly saveRun: (
    repositoryRoot: string,
    profileId: string,
    checkpoint: EvalSetupRunCheckpoint
  ) => Effect.Effect<void, EvalSetupStateError>;
};

export class EvalSetupStateStore extends Context.Service<
  EvalSetupStateStore,
  EvalSetupStateStoreShape
>()("@velum-labs/routekit-eval-setup/EvalSetupStateStore") {}

const safeProfileId = (profileId: string): boolean =>
  /^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(profileId);

const setupDirectory = (paths: Path.Path, root: string, profileId: string): string =>
  paths.join(root, ".routekit", "eval-setup", profileId);
const statePath = (paths: Path.Path, root: string, profileId: string): string =>
  paths.join(setupDirectory(paths, root, profileId), "state.json");
const runPath = (paths: Path.Path, root: string, profileId: string): string =>
  paths.join(setupDirectory(paths, root, profileId), "run.json");

const stateFailure = (operation: string, cause: unknown): EvalSetupStateError =>
  new EvalSetupStateError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause
  });

const validateProfileId = (profileId: string): Effect.Effect<void, EvalSetupStateError> =>
  safeProfileId(profileId)
    ? Effect.void
    : Effect.fail(
        new EvalSetupStateError({
          operation: "resolving setup state",
          detail: `invalid profile id ${JSON.stringify(profileId)}`
        })
      );

export const makeFileEvalSetupStateStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  const loadDocument = <A>(
    target: string,
    decode: (value: unknown) => Effect.Effect<A, unknown>
  ): Effect.Effect<A | undefined, EvalSetupStateError> =>
    Effect.gen(function* () {
      if (
        !(yield* fs
          .exists(target)
          .pipe(Effect.mapError((cause) => stateFailure("checking setup document", cause))))
      ) {
        return undefined;
      }
      const raw = yield* fs
        .readFileString(target)
        .pipe(Effect.mapError((cause) => stateFailure("reading setup document", cause)));
      const json = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) => stateFailure("parsing setup document", cause)
      });
      return yield* decode(json).pipe(
        Effect.mapError((cause) => stateFailure("decoding setup document", cause))
      );
    });

  const saveDocument = (
    target: string,
    value: unknown,
    revision: number | string
  ): Effect.Effect<void, EvalSetupStateError> =>
    Effect.gen(function* () {
      const directory = paths.dirname(target);
      const temporary = paths.join(directory, `setup.${revision}.${crypto.randomUUID()}.tmp`);
      yield* fs
        .makeDirectory(directory, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError((cause) => stateFailure("creating setup state directory", cause)));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* fs
            .writeFileString(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
            .pipe(Effect.mapError((cause) => stateFailure("writing setup document", cause)));
          yield* fs
            .rename(temporary, target)
            .pipe(Effect.mapError((cause) => stateFailure("committing setup document", cause)));
        }),
        fs.remove(temporary, { force: true }).pipe(Effect.ignore)
      );
    });

  return EvalSetupStateStore.of({
    load: (repositoryRoot, profileId) =>
      Effect.gen(function* () {
        yield* validateProfileId(profileId);
        return yield* loadDocument(
          statePath(paths, repositoryRoot, profileId),
          Schema.decodeUnknownEffect(EvalSetupStateSchema)
        );
      }),
    save: (state) =>
      Effect.gen(function* () {
        yield* validateProfileId(state.profileId);
        yield* saveDocument(
          statePath(paths, state.repositoryRoot, state.profileId),
          state,
          state.revision
        );
      }),
    loadRun: (repositoryRoot, profileId) =>
      Effect.gen(function* () {
        yield* validateProfileId(profileId);
        return yield* loadDocument(
          runPath(paths, repositoryRoot, profileId),
          Schema.decodeUnknownEffect(EvalSetupRunCheckpointSchema)
        );
      }),
    saveRun: (repositoryRoot, profileId, checkpoint) =>
      Effect.gen(function* () {
        yield* validateProfileId(profileId);
        yield* saveDocument(
          runPath(paths, repositoryRoot, profileId),
          checkpoint,
          checkpoint.comparison.comparisonId
        );
      })
  });
});

export const EvalSetupStateStoreLive = Layer.effect(
  EvalSetupStateStore,
  makeFileEvalSetupStateStore
);

export const initialSetupState = (input: {
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly now: string;
}): EvalSetupState => ({
  version: EVAL_SETUP_VERSION,
  profileId: input.profileId,
  repositoryRoot: input.repositoryRoot,
  stage: "surface",
  revision: 0,
  updatedAt: input.now,
  answers: {}
});
