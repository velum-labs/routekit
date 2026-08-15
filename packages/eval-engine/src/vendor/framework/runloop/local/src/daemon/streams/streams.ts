import type { Stream } from "effect";

import { Effect } from "effect";

import type { RuntimeJournalEntry } from "../../../../../contracts/internal/src/runtime/journal-entry.ts";
import type { DaemonRuntime } from "../server/server-types.ts";

import { RuntimeEventJournal } from "../../../../../engine/events/src/event-journal-service.ts";
import { DaemonLogHub } from "../logging/log-hub.ts";

export interface DaemonStreams {
  /** The runtime event journal tail (the source behind `/api/events/stream`). */
  readonly eventEntries: Stream.Stream<RuntimeJournalEntry>;
  /** Read the latest sequence without opening another daemon subscription. */
  readonly latestEventSequence: Effect.Effect<number>;
  /** The operational log hub tail (the source behind `/api/logs/stream`). */
  readonly logLines: Stream.Stream<string>;
}

/**
 * Read a running daemon's in-process log and runtime-event tails straight from
 * its services. These are the same sources the daemon exposes over
 * `/api/logs/stream` and `/api/events/stream`, but consuming them directly
 * matters for any consumer living in the daemon's own process (e.g. the dev
 * event-log file): a loopback HTTP subscription would keep an in-flight
 * streaming response open and block the daemon's graceful shutdown. The
 * returned streams are self-contained (they close over the services' PubSubs),
 * so the caller can run them outside the daemon runtime's context.
 */
export const acquireDaemonStreams = Effect.fn("Daemon.acquireStreams")(
  function* (runtime: DaemonRuntime) {
    const context = yield* runtime.contextEffect;
    return yield* Effect.gen(function* () {
      const hub = yield* DaemonLogHub;
      const journal = yield* RuntimeEventJournal;
      return {
        eventEntries: journal.tail,
        latestEventSequence: journal
          .entries()
          .pipe(Effect.map((entries) => entries.at(-1)?.sequence ?? 0)),
        logLines: hub.tail,
      } satisfies DaemonStreams;
    }).pipe(Effect.provide(context));
  }
);
