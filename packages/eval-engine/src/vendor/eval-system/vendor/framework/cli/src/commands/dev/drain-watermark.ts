import { Duration, Effect, Stream, SubscriptionRef } from "effect";

export type DrainWatermark = SubscriptionRef.SubscriptionRef<number>;

const DRAIN_FLUSH_TIMEOUT = Duration.seconds(2);

/**
 * A durable drain publishes the highest journal `sequence` it has persisted.
 * Awaiting that watermark lets a fast-exiting one-shot know its tail caught up.
 * The timeout is bounded and best-effort so a stalled drain cannot hang or fail
 * the session.
 */
export const awaitProcessedSequence = (
  processedSequence: DrainWatermark,
  latestSequence: Effect.Effect<number>
): Effect.Effect<void> =>
  latestSequence.pipe(
    Effect.flatMap((target) =>
      SubscriptionRef.changes(processedSequence).pipe(
        Stream.filter((sequence) => sequence >= target),
        Stream.runHead,
        Effect.asVoid
      )
    ),
    Effect.timeoutOption(DRAIN_FLUSH_TIMEOUT),
    Effect.asVoid
  );

export const awaitDurableDrains = (
  processedSequence: DrainWatermark,
  latestSequence: Effect.Effect<number>,
  metadataFlush: Effect.Effect<void>
): Effect.Effect<void> =>
  Effect.all(
    [awaitProcessedSequence(processedSequence, latestSequence), metadataFlush],
    { concurrency: "unbounded" }
  ).pipe(Effect.asVoid);
