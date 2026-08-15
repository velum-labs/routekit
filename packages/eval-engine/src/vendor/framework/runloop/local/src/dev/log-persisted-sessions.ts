import { Effect, Option } from "effect";

import type { SessionMetadata } from "../../../../contracts/internal/src/runtime/session-metadata.ts";
import type { DevLogStoreContext } from "./log-store-paths.ts";

import { decodeSessionMetadata } from "../../../../contracts/internal/src/runtime/session-metadata.ts";
import {
  isSafeRunId,
  sessionMetadataFilePath,
  sessionsDir,
} from "./log-store-paths.ts";

export const listPersistedSessionMetadata = Effect.fn(
  "DevLogStore.listPersistedSessionMetadata"
)(function* (context: DevLogStoreContext) {
  const { fs, path, logsDir } = context;
  const ids = yield* fs
    .readDirectory(sessionsDir(logsDir, path))
    .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
  const metadata = yield* Effect.forEach(
    ids,
    (sessionId) =>
      Effect.gen(function* () {
        if (!isSafeRunId(sessionId)) {
          return Option.none<SessionMetadata>();
        }
        const contents = yield* fs
          .readFileString(sessionMetadataFilePath(logsDir, path, sessionId))
          .pipe(Effect.option);
        if (Option.isNone(contents)) {
          return Option.none<SessionMetadata>();
        }
        return yield* decodeSessionMetadata(contents.value).pipe(Effect.option);
      }),
    { concurrency: "unbounded" }
  );
  return metadata
    .flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []))
    .toSorted((left, right) => right.endedAt.localeCompare(left.endedAt));
});

export type { SessionMetadata };
