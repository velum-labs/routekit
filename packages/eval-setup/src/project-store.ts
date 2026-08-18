import { writeFileAtomicEffect } from "@velum-labs/routekit-runtime/effect";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

import { EvalProjectStoreError } from "./errors.js";
import { EvalProjectState } from "./project-contracts.js";

const PROJECT_FILE = "project.json";

export type EvalProjectStoreShape = {
  readonly load: (
    repositoryRoot: string
  ) => Effect.Effect<EvalProjectState | undefined, EvalProjectStoreError>;
  readonly save: (
    repositoryRoot: string,
    state: EvalProjectState
  ) => Effect.Effect<void, EvalProjectStoreError>;
};

export class EvalProjectStore extends Context.Service<EvalProjectStore, EvalProjectStoreShape>()(
  "@velum-labs/routekit-eval-setup/EvalProjectStore"
) {}

const storeFailure = (
  operation: EvalProjectStoreError["operation"],
  path: string,
  cause: unknown
): EvalProjectStoreError =>
  new EvalProjectStoreError({
    operation,
    path,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause
  });

export const makeFileEvalProjectStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  const projectPath = (root: string): string =>
    paths.join(paths.resolve(root), ".routekit", "evals", PROJECT_FILE);

  return EvalProjectStore.of({
    load: (repositoryRoot) =>
      Effect.gen(function* () {
        const root = yield* fs
          .realPath(repositoryRoot)
          .pipe(Effect.mapError((cause) => storeFailure("resolving", repositoryRoot, cause)));
        const target = projectPath(root);
        const exists = yield* fs
          .exists(target)
          .pipe(Effect.mapError((cause) => storeFailure("checking", target, cause)));
        if (!exists) return undefined;
        const encoded = yield* fs
          .readFileString(target)
          .pipe(Effect.mapError((cause) => storeFailure("reading", target, cause)));
        const json = yield* Effect.try({
          try: () => JSON.parse(encoded) as unknown,
          catch: (cause) => storeFailure("parsing", target, cause)
        });
        return yield* Schema.decodeUnknownEffect(EvalProjectState)(json).pipe(
          Effect.mapError((cause) => storeFailure("decoding", target, cause))
        );
      }),
    save: (repositoryRoot, state) =>
      Effect.gen(function* () {
        const root = yield* fs
          .realPath(repositoryRoot)
          .pipe(Effect.mapError((cause) => storeFailure("resolving", repositoryRoot, cause)));
        const target = projectPath(root);
        const directory = paths.dirname(target);
        yield* fs
          .makeDirectory(directory, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError((cause) => storeFailure("creating", directory, cause)));
        yield* writeFileAtomicEffect(target, `${JSON.stringify(state, null, 2)}\n`, {
          mode: 0o600
        }).pipe(
          Effect.mapError((cause) => storeFailure("committing", target, cause)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, paths)
        );
      })
  });
});

export const EvalProjectStoreLive = Layer.effect(EvalProjectStore, makeFileEvalProjectStore);
