import { toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

export type HostGenerationStage = "prepare" | "validate" | "persist" | "commit" | "retire";

/**
 * Host rolling replacement as an explicit prepare/validate/persist/commit/retire
 * transaction. Pre-publication failures roll the candidate back; retirement
 * after commit is best-effort and must not undo the published generation.
 */
export type HostGenerationTransaction<TCandidate, TResult> = {
  onStage?: (stage: HostGenerationStage) => void;
  prepare(): Promise<TCandidate>;
  validate(candidate: TCandidate): Promise<void>;
  persist(candidate: TCandidate): Promise<void> | void;
  commit(candidate: TCandidate): Promise<TResult> | TResult;
  rollback(candidate: TCandidate | undefined, error: unknown): Promise<void>;
  retire(): void | Promise<void>;
};

function stage<A>(
  transaction: HostGenerationTransaction<unknown, unknown>,
  name: HostGenerationStage,
  work: () => Promise<A> | A
): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: async () => {
      transaction.onStage?.(name);
      return await work();
    },
    catch: toRouteKitFailure
  });
}

export function runHostGenerationTransactionEffect<TCandidate, TResult>(
  transaction: HostGenerationTransaction<TCandidate, TResult>
): Effect.Effect<TResult, Error> {
  return Effect.gen(function* () {
    let candidate: TCandidate | undefined;
    const published = yield* Effect.gen(function* () {
      candidate = yield* stage(transaction, "prepare", () => transaction.prepare());
      yield* stage(transaction, "validate", () => transaction.validate(candidate as TCandidate));
      yield* stage(transaction, "persist", () => transaction.persist(candidate as TCandidate));
      const result = yield* stage(transaction, "commit", () =>
        transaction.commit(candidate as TCandidate)
      );
      yield* stage(transaction, "retire", () => transaction.retire()).pipe(Effect.ignore);
      return result;
    }).pipe(
      Effect.catch((error) =>
        Effect.tryPromise({
          try: () => transaction.rollback(candidate, error),
          catch: (rollbackError) =>
            new AggregateError(
              [error, rollbackError],
              "host generation failed and rollback was incomplete"
            )
        }).pipe(Effect.andThen(Effect.fail(error)))
      )
    );
    return published;
  });
}
