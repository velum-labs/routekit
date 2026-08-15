import { Effect, FileSystem, Layer, Option, Path } from "effect";

import type { SessionOwnershipStoreShape } from "../../../../engine/selected-adapter/src/ownership-store.ts";

import { encodeJsonString } from "../../../../contracts/internal/src/json.ts";
import {
  decodeSessionOwnershipRecord,
  SessionOwnershipRecordSchema,
} from "../../../../contracts/internal/src/runtime/session-ownership.ts";
import {
  layerSessionOwnershipStoreMemory,
  SessionOwnershipPersistenceError,
  SessionOwnershipStore,
} from "../../../../engine/selected-adapter/src/ownership-store.ts";
import { findWorkspaceRootFromCwd } from "../dev/descriptor.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const OWNERSHIP_DIR_SEGMENTS = [".routekit-eval", "sessions"] as const;
const JSON_INDENT = 2;
const TMP_SUFFIX = ".tmp";

const persistenceError =
  (sessionId: string) =>
  (cause: unknown): SessionOwnershipPersistenceError =>
    new SessionOwnershipPersistenceError({
      detail: formatUnknownError(cause),
      sessionId,
    });

/**
 * Session IDs are minted by adapters, so they reach this store as untrusted path
 * input. Percent-encoding removes every separator; `.` and `..` survive it
 * unchanged and are the only encoded results that would still escape.
 */
const recordFileName = (sessionId: string): Option.Option<string> => {
  const encoded = encodeURIComponent(sessionId);
  return encoded.length === 0 || encoded === "." || encoded === ".."
    ? Option.none()
    : Option.some(`${encoded}.json`);
};

const makeFileStore = (input: {
  readonly directory: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}): SessionOwnershipStoreShape => {
  const fileFor = (sessionId: string): Option.Option<string> =>
    recordFileName(sessionId).pipe(
      Option.map((name) => input.path.join(input.directory, name))
    );

  return {
    read: (sessionId) =>
      Effect.gen(function* () {
        const file = fileFor(sessionId);
        if (Option.isNone(file)) {
          return Option.none();
        }
        const present = yield* input.fs
          .exists(file.value)
          .pipe(Effect.mapError(persistenceError(sessionId)));
        if (!present) {
          return Option.none();
        }
        const contents = yield* input.fs
          .readFileString(file.value)
          .pipe(Effect.mapError(persistenceError(sessionId)));
        return yield* decodeSessionOwnershipRecord(contents).pipe(
          Effect.option
        );
      }),

    remove: (sessionId) => {
      const file = fileFor(sessionId);
      return Option.isNone(file)
        ? Effect.void
        : input.fs
            .remove(file.value, { force: true })
            .pipe(Effect.mapError(persistenceError(sessionId)));
    },

    write: (record) =>
      Effect.gen(function* () {
        const file = fileFor(record.sessionId);
        if (Option.isNone(file)) {
          return yield* new SessionOwnershipPersistenceError({
            detail: `Session id is not storable as a file name: ${record.sessionId}`,
            sessionId: record.sessionId,
          });
        }
        const fail = persistenceError(record.sessionId);
        const serialized = yield* encodeJsonString(
          SessionOwnershipRecordSchema,
          JSON_INDENT
        )(record).pipe(Effect.mapError(fail));
        const temporary = `${file.value}${TMP_SUFFIX}`;
        yield* input.fs
          .makeDirectory(input.directory, { recursive: true })
          .pipe(Effect.mapError(fail));
        yield* input.fs
          .writeFileString(temporary, `${serialized}\n`)
          .pipe(Effect.mapError(fail));
        yield* input.fs
          .rename(temporary, file.value)
          .pipe(Effect.mapError(fail));
      }),
  };
};

/**
 * Ownership on disk under `<workspace>/.routekit-eval/sessions/`, deliberately outside
 * `.routekit-eval/logs/`: log sidecars are a pruned projection of runtime events, and a
 * session has to stay resumable after its transcript ages out.
 *
 * Outside a workspace there is nowhere durable to write, so ownership falls back
 * to the process-lifetime store rather than failing every turn.
 */
const layerSessionOwnershipStoreLive: Layer.Layer<
  SessionOwnershipStore,
  never,
  FileSystem.FileSystem | Path.Path
> = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* findWorkspaceRootFromCwd(
      fs,
      path,
      path.resolve()
    ).pipe(Effect.orElseSucceed(() => null));
    if (workspaceRoot === null) {
      return layerSessionOwnershipStoreMemory;
    }
    return Layer.succeed(
      SessionOwnershipStore,
      makeFileStore({
        directory: path.join(workspaceRoot, ...OWNERSHIP_DIR_SEGMENTS),
        fs,
        path,
      })
    );
  })
);

export { layerSessionOwnershipStoreLive };
