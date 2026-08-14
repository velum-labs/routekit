import { toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

export type HostGenerationStage = "prepare" | "validate" | "persist" | "commit" | "retire";

/**
 * Host rolling replacement as an explicit prepare/validate/persist/commit/retire
 * transaction. Pre-publication failures roll the candidate back; retirement
 * after commit is best-effort and must not undo the published generation.
 */
export type HostGenerationTransaction<TCandidate, TResult, R = never> = {
  onStage?: (stage: HostGenerationStage) => void;
  prepare(): Effect.Effect<TCandidate, Error, R>;
  validate(candidate: TCandidate): Effect.Effect<void, Error, R>;
  persist(candidate: TCandidate): Effect.Effect<void, Error, R>;
  commit(candidate: TCandidate): Effect.Effect<TResult, Error, R>;
  rollback(candidate: TCandidate | undefined, error: unknown): Effect.Effect<void, Error, R>;
  retire(): Effect.Effect<void, Error, R>;
};

function stage<A, R>(
  transaction: HostGenerationTransaction<unknown, unknown, R>,
  name: HostGenerationStage,
  work: () => Effect.Effect<A, Error, R>
): Effect.Effect<A, Error, R> {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        transaction.onStage?.(name);
      },
      catch: toRouteKitFailure
    });
    return yield* work();
  });
}

export function runHostGenerationTransactionEffect<TCandidate, TResult, R = never>(
  transaction: HostGenerationTransaction<TCandidate, TResult, R>
): Effect.Effect<TResult, Error, R> {
  return Effect.gen(function* () {
    let candidate: TCandidate | undefined;
    return yield* Effect.gen(function* () {
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
        transaction.rollback(candidate, error).pipe(
          Effect.catch((rollbackError) =>
            Effect.fail(
              new AggregateError(
                [error, rollbackError],
                "host generation failed and rollback was incomplete"
              )
            )
          ),
          Effect.andThen(Effect.fail(error))
        )
      )
    );
  });
}
