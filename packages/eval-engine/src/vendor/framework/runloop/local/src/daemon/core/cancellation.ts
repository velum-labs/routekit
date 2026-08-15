import { Deferred, Effect, Ref } from "effect";

import type { InvocationCancellation } from "../invoke/invoke.ts";

interface CancellationEntry {
  readonly cancellation: InvocationCancellation;
  readonly cancelled: Ref.Ref<boolean>;
  readonly signal: Deferred.Deferred<unknown>;
}

interface CancellationRegistry {
  readonly begin: (commandId: string) => Effect.Effect<CancellationEntry>;
  readonly cancel: (commandId: string) => Effect.Effect<void>;
  readonly remove: (commandId: string) => Effect.Effect<void>;
}

export const makeCancellationRegistry = (): CancellationRegistry => {
  const entries = new Map<string, CancellationEntry>();
  const begin = Effect.fn("DaemonCancellation.begin")(function* (
    commandId: string
  ) {
    const entry = {
      cancelled: yield* Ref.make(false),
      signal: yield* Deferred.make<unknown>(),
    };
    const registered: CancellationEntry = {
      cancellation: {
        cancelled: entry.cancelled,
        signal: Deferred.await(entry.signal),
      },
      cancelled: entry.cancelled,
      signal: entry.signal,
    };
    entries.set(commandId, registered);
    return registered;
  });
  return {
    begin,
    cancel: Effect.fn("DaemonCancellation.cancel")(function* (
      commandId: string
    ) {
      const entry = entries.get(commandId);
      if (entry === undefined) {
        return;
      }
      yield* Ref.set(entry.cancelled, true);
      yield* Deferred.succeed(entry.signal, null);
    }),
    remove: (commandId) =>
      Effect.sync(() => {
        entries.delete(commandId);
      }),
  };
};

export type { CancellationEntry, CancellationRegistry };
