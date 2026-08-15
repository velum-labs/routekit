import { Effect, FileSystem, Path, Ref, Stream, SubscriptionRef } from "effect";

import type { RuntimeJournalEntry } from "../../../../contracts/internal/src/runtime/journal-entry.ts";
import type { SessionMetadata } from "../../../../contracts/internal/src/runtime/session-metadata.ts";
import type { DrainWatermark } from "./drain-watermark.ts";

import { encodeJsonString } from "../../../../contracts/internal/src/json.ts";
import { journalEntrySessionId } from "../../../../contracts/internal/src/runtime/journal-entry-session.ts";
import { SessionMetadataSchema } from "../../../../contracts/internal/src/runtime/session-metadata.ts";
import {
  applySessionMetadataEvent,
  emptySessionMetadataProjection,
} from "../../../../engine/session/src/session-metadata.ts";
import { sessionMetadataFilePath } from "../../../../runloop/local/src/dev/log-store.ts";
import { awaitProcessedSequence } from "./drain-watermark.ts";

const textEncoder = new TextEncoder();
const JSON_INDENT = 2;

interface DrainSessionMetadataInput {
  readonly eventEntries: Stream.Stream<RuntimeJournalEntry>;
  readonly logsDir: string;
  readonly processedSequence?: DrainWatermark;
}

interface SessionMetadataSidecarHandle {
  readonly flush: Effect.Effect<void>;
}

// A write error is swallowed so a locked/full disk can never take down the
// session — the same discipline the run-file tee follows. The sidecar is a
// derived projection: it is rewritten in full on every patch from the folded
// map, so it always matches what the run stream implies.
const writeSessionMetadata = Effect.fn("DevCommand.writeSessionMetadata")(
  function* (logsDir: string, metadata: SessionMetadata) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = sessionMetadataFilePath(logsDir, path, metadata.sessionId);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    const serialized = yield* encodeJsonString(
      SessionMetadataSchema,
      JSON_INDENT
    )(metadata);
    yield* fs.writeFile(filePath, textEncoder.encode(`${serialized}\n`));
  }
);

/**
 * Fold the same runtime-event tail the run-file tee consumes into per-session
 * metadata and patch each affected session's sidecar as it progresses. The
 * sidecar is a **projection over the run file, never a second writer**: this
 * consumes the identical event stream and rewrites `metadata.json` from the
 * folded map, so it can be rebuilt from the run file and can never disagree
 * with it. Exposed (apart from {@link startSessionMetadataSidecars}) so tests
 * can drive it with an in-memory stream.
 */
const drainSessionMetadataToFiles = Effect.fn(
  "DevCommand.drainSessionMetadataToFiles"
)(function* (input: DrainSessionMetadataInput) {
  const projection = yield* Ref.make(emptySessionMetadataProjection);
  yield* input.eventEntries.pipe(
    Stream.mapEffect((entry) =>
      Effect.gen(function* () {
        const sessionId = journalEntrySessionId(entry);
        const next = applySessionMetadataEvent(
          yield* Ref.get(projection),
          entry.event
        );
        yield* Ref.set(projection, next);
        if (sessionId !== undefined) {
          const metadata = next.sessions.get(sessionId);
          if (metadata !== undefined) {
            yield* writeSessionMetadata(input.logsDir, metadata).pipe(
              Effect.ignore
            );
          }
        }
        if (input.processedSequence !== undefined) {
          yield* SubscriptionRef.set(input.processedSequence, entry.sequence);
        }
      })
    ),
    Stream.runDrain
  );
});

interface StartSessionMetadataSidecarsInput {
  readonly eventEntries: Stream.Stream<RuntimeJournalEntry>;
  readonly logsDir: string;
  readonly latestEventSequence: Effect.Effect<number>;
}

/**
 * Start the per-session metadata sidecar writer for a booted daemon. Forks the
 * drain into the caller's scope (so it tears down with the session) and
 * swallows any failure — the sidecar is additive diagnostics and must never
 * take down the session, exactly like the run-file tee.
 */
export const startSessionMetadataSidecars = Effect.fn(
  "DevCommand.sessionMetadataSidecars"
)(function* (input: StartSessionMetadataSidecarsInput) {
  const processedSequence = yield* SubscriptionRef.make(0);
  yield* drainSessionMetadataToFiles({
    eventEntries: input.eventEntries,
    logsDir: input.logsDir,
    processedSequence,
  }).pipe(Effect.ignore, Effect.forkScoped);
  return {
    flush: awaitProcessedSequence(processedSequence, input.latestEventSequence),
  } satisfies SessionMetadataSidecarHandle;
});

export { drainSessionMetadataToFiles };
export type {
  DrainSessionMetadataInput,
  SessionMetadataSidecarHandle,
  StartSessionMetadataSidecarsInput,
};
