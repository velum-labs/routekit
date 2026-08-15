import { Context, Effect, Layer, PubSub, Ref, Stream } from "effect";

const EMPTY_SEQUENCE = 0;
const FIRST_SEQUENCE = 1;
/** Backlog replayed to late subscribers (e.g. an SSE client attaching after boot). */
const MAX_REPLAY_LINES = 500;

interface HubLine {
  readonly line: string;
  readonly sequence: number;
}

interface HubState {
  readonly lines: readonly HubLine[];
  readonly nextSequence: number;
}

export interface DaemonLogHubShape {
  readonly publish: (line: string) => Effect.Effect<void>;
  /** Replays the buffered backlog, then follows live lines until shutdown. */
  readonly tail: Stream.Stream<string>;
}

/**
 * In-memory broadcast for daemon operational log lines (audit log, reload
 * watcher notices). The daemon serves it over `GET /api/logs/stream` and tees
 * it into the durable `.routekit-eval/logs` run file, so dev-server output can be
 * followed (e.g. `routekit-eval logs --live`) without sharing stdout.
 */
export class DaemonLogHub extends Context.Service<
  DaemonLogHub,
  DaemonLogHubShape
>()("routekit-eval/runtime/DaemonLogHub") {
  static readonly layer = Layer.effect(DaemonLogHub)(
    Effect.gen(function* () {
      const state = yield* Ref.make<HubState>({
        lines: [],
        nextSequence: FIRST_SEQUENCE,
      });
      const pubsub = yield* PubSub.unbounded<HubLine>();

      const publish = Effect.fn("DaemonLogHub.publish")(function* (
        line: string
      ) {
        const entry = yield* Ref.modify(state, (current) => {
          const next: HubLine = {
            line,
            sequence: current.nextSequence,
          };
          return [
            next,
            {
              lines: [...current.lines, next].slice(-MAX_REPLAY_LINES),
              nextSequence: current.nextSequence + 1,
            },
          ] as const;
        });
        yield* PubSub.publish(pubsub, entry).pipe(Effect.asVoid);
      });

      // Subscribe before reading the snapshot so no line published between
      // the two steps is lost; the sequence filter drops replayed lines.
      const tail = Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          const snapshot = yield* Ref.get(state);
          const lastReplayedSequence =
            snapshot.lines.at(-1)?.sequence ?? EMPTY_SEQUENCE;
          return Stream.concat(
            Stream.fromIterable(snapshot.lines),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((entry) => entry.sequence > lastReplayedSequence)
            )
          ).pipe(Stream.map((entry) => entry.line));
        })
      );

      return DaemonLogHub.of({
        publish,
        tail,
      });
    })
  );
}
