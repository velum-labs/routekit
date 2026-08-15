import { Clock, Crypto, Effect, Layer, PubSub, Ref, Stream } from "effect";

import type { AgentRuntimeEvent } from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";

import {
  RuntimeJournalError,
  RuntimeValidationError,
} from "../../../contracts/internal/src/errors.ts";
import { RuntimeJournalEntryId } from "../../../contracts/internal/src/ids.ts";
import { decodeAgentRuntimeEvent } from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";
import { decodeRuntimeJournalEntry } from "../../../contracts/internal/src/runtime/journal-entry.ts";

import type { RuntimeEventJournalShape } from "./event-journal-service.ts";

import { AgentEventBus } from "./event-bus.ts";
import { RuntimeEventJournal as RuntimeEventJournalService } from "./event-journal-service.ts";

const RuntimeEventJournal = RuntimeEventJournalService;

const EMPTY_SEQUENCE = 0;
const FIRST_SEQUENCE = 1;
export const DEFAULT_JOURNAL_MAX_EVENTS = 100_000;

type RuntimeProtocolJournalEntry =
  ReturnType<RuntimeEventJournalShape["entries"]> extends Effect.Effect<
    readonly (infer Entry)[],
    unknown,
    unknown
  >
    ? Entry
    : never;

interface RuntimeJournalState {
  readonly entries: readonly RuntimeProtocolJournalEntry[];
  readonly nextSequence: number;
}

const retainEntries = (
  entries: readonly RuntimeProtocolJournalEntry[],
  maxEvents: number
): readonly RuntimeProtocolJournalEntry[] =>
  Number.isFinite(maxEvents) && maxEvents > 0 ? entries.slice(-maxEvents) : [];

const makeJournalEntry = Effect.fn("RuntimeEventJournal.makeEntry")(
  function* (input: {
    readonly state: Ref.Ref<RuntimeJournalState>;
    readonly crypto: Crypto.Crypto;
    readonly event: AgentRuntimeEvent;
    readonly maxEvents: number;
  }) {
    const currentTimeMillis = yield* Clock.currentTimeMillis;
    const entryId = yield* input.crypto.randomUUIDv4.pipe(
      Effect.map(RuntimeJournalEntryId.make),
      Effect.mapError(
        (cause) =>
          new RuntimeJournalError({
            cause,
            detail: "Could not generate runtime journal entry id",
            operation: "append",
          })
      )
    );
    const entry = yield* Ref.modify(input.state, (current) => {
      const nextEntry: RuntimeProtocolJournalEntry = {
        entryId,
        event: input.event,
        recordedAt: new Date(currentTimeMillis).toISOString(),
        sequence: current.nextSequence,
      };
      const nextEntries = [...current.entries, nextEntry];
      return [
        nextEntry,
        {
          entries: retainEntries(nextEntries, input.maxEvents),
          nextSequence: current.nextSequence + 1,
        },
      ] as const;
    });

    return yield* decodeRuntimeJournalEntry(entry).pipe(
      Effect.mapError(
        (cause) =>
          new RuntimeJournalError({
            cause,
            detail: "Invalid runtime journal entry",
            operation: "append",
          })
      )
    );
  }
);

export const makeRuntimeEventJournalLayer = (options: {
  readonly maxEvents: number;
}): Layer.Layer<
  RuntimeEventJournalService,
  never,
  AgentEventBus | Crypto.Crypto
> =>
  Layer.effect(RuntimeEventJournal)(
    Effect.gen(function* () {
      const eventBus = yield* AgentEventBus;
      const crypto = yield* Crypto.Crypto;
      const state = yield* Ref.make<RuntimeJournalState>({
        entries: [],
        nextSequence: FIRST_SEQUENCE,
      });
      const pubsub = yield* PubSub.unbounded<RuntimeProtocolJournalEntry>();
      const append = Effect.fn("RuntimeEventJournal.append")(function* (
        event: AgentRuntimeEvent
      ) {
        const decoded = yield* decodeAgentRuntimeEvent(event).pipe(
          Effect.mapError(
            (cause) =>
              new RuntimeValidationError({
                cause,
                detail: "Invalid agent runtime event",
              })
          )
        );
        const entry = yield* makeJournalEntry({
          state,
          crypto,
          event: decoded,
          maxEvents: options.maxEvents,
        });
        yield* eventBus.publish(decoded);
        yield* PubSub.publish(pubsub, entry).pipe(Effect.asVoid);
        return entry;
      });

      // Subscribe before reading the snapshot so no entry appended between the
      // two steps is lost; the sequence filter drops entries already replayed.
      const tail = Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          const snapshot = yield* Ref.get(state).pipe(
            Effect.map(({ entries }) => entries)
          );
          const lastReplayedSequence =
            snapshot.at(-1)?.sequence ?? EMPTY_SEQUENCE;
          return Stream.concat(
            Stream.fromIterable(snapshot),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((entry) => entry.sequence > lastReplayedSequence)
            )
          );
        })
      );

      return RuntimeEventJournal.of({
        append,
        entries: () =>
          Ref.get(state).pipe(Effect.map(({ entries }) => entries)),
        stream: Stream.fromPubSub(pubsub),
        tail,
      });
    })
  );

export const runtimeEventJournalLayer = makeRuntimeEventJournalLayer({
  maxEvents: DEFAULT_JOURNAL_MAX_EVENTS,
});

export { RuntimeEventJournal };
