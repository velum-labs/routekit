/**
 * A bounded, cancellable, multi-consumer bridge from a push-style event source
 * to any number of pull-style `for await` consumers.
 *
 * Several runloop call sites need the same thing: eagerly drain an
 * `AsyncIterable` event source so a run starts as soon as it is requested, then
 * let one or more consumers each observe the sequence (a `for await`, a
 * `text()`/`output()` reducer, an event tap). Every site had hand-rolled the
 * buffer + waker-deferred + finished-flag bridge separately, and each copy
 * shared two footguns: the buffer grew **unbounded** (no backpressure on a long
 * run, and consumed events were never released), and there was **no
 * cancellation** — a consumer breaking early left the underlying source running
 * to completion. This module owns that bridge once, with both footguns fixed.
 *
 * Semantics:
 * - **Replay for attached consumers.** Every consumer that attaches before the
 *   source runs ahead sees the whole sequence from its attach point. Consumers
 *   that attach together (the common case: a `for await` plus a `text()` drain)
 *   advance in lockstep and each observe every event.
 * - **Bounded.** Two mechanisms keep memory O(capacity), not O(total events):
 *   the producer pauses once the slowest live consumer is `capacity` events
 *   behind (backpressure), and an event is dropped from the front once **every**
 *   live consumer has read past it (eviction). A capacity of `0`/`undefined`
 *   disables backpressure but eviction still runs, so a fast consumer still
 *   bounds retention.
 * - **Live tail on late attach.** A consumer that attaches after some events
 *   have been evicted starts from the current front, like subscribing to a live
 *   stream. No runloop caller attaches late expecting replay-from-zero; the
 *   prior hand-rolled buffers technically retained everything for the object's
 *   lifetime, which is exactly the unbounded growth this replaces.
 * - **Cancellable.** {@link ReplayEventStream.cancel} tells the source to stop
 *   (via the async iterator's `return()`), wakes every consumer, and ends their
 *   iteration cleanly. It is idempotent and safe to call from a consumer's
 *   `finally` (e.g. an early `break`).
 * - **Failure propagation.** A source that throws stores the error; a consumer
 *   that reaches the end of the buffer re-throws it, matching prior behavior.
 */

const NO_CAPACITY = 0;
const FIRST_INDEX = 0;

interface ReplayEventStreamOptions<Event> {
  /**
   * Maximum number of un-consumed events (measured from the slowest live
   * consumer) the producer may run ahead before it pauses. `0` or omitted
   * disables the producer pause; eviction of fully-consumed events still runs.
   */
  readonly capacity?: number | undefined;
  /** Observe every event as it is drained, in order. */
  readonly onEvent?: ((event: Event) => void) | undefined;
  /** Starts the push source. Called once, lazily, on the first consumer or `start()`. */
  readonly source: () => AsyncIterable<Event>;
}

const asError = (value: unknown): Error =>
  value instanceof Error
    ? value
    : new Error(typeof value === "string" ? value : JSON.stringify(value));

/**
 * Wrap a push-style event source in a bounded, cancellable, multi-consumer
 * replay stream. The source is not started until the first consumer attaches or
 * {@link ReplayEventStream.start} is called.
 */
class ReplayEventStream<Event> implements AsyncIterable<Event> {
  /** Retained events, holding absolute indices `[baseOffset, baseOffset + buffer.length)`. */
  private readonly buffer: Event[] = [];
  /** Count of events evicted from the front, so cursors can use absolute indices. */
  private baseOffset = 0;
  private readonly capacity: number;
  private cancelled = false;
  private failure: unknown;
  private finished = false;
  private readonly onEvent: ((event: Event) => void) | undefined;
  /** Resolved when the slowest consumer advances, so a paused producer can resume. */
  private producerWaker: (() => void) | undefined;
  /** Absolute read positions of every live consumer, used for eviction and backpressure. */
  private readonly readCursors = new Set<{ index: number }>();
  private readonly source: () => AsyncIterable<Event>;
  private sourceIterator: AsyncIterator<Event> | undefined;
  private started = false;
  /** Consumer wakers, resolved when a new event is buffered or the stream ends. */
  private wakers: (() => void)[] = [];

  constructor(options: ReplayEventStreamOptions<Event>) {
    this.source = options.source;
    this.onEvent = options.onEvent;
    this.capacity = options.capacity ?? NO_CAPACITY;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Event> {
    this.start();
    const cursor = { index: Math.max(FIRST_INDEX, this.baseOffset) };
    this.readCursors.add(cursor);
    try {
      for (;;) {
        while (cursor.index < this.absoluteEnd()) {
          const event = this.buffer.at(cursor.index - this.baseOffset);
          cursor.index += 1;
          this.evictConsumed();
          this.wakeProducer();
          if (event !== undefined) {
            yield event;
          }
        }
        if (this.finished || this.cancelled) {
          if (this.failure !== undefined) {
            throw asError(this.failure);
          }
          return;
        }
        await this.nextWake();
      }
    } finally {
      this.readCursors.delete(cursor);
      this.evictConsumed();
      this.wakeProducer();
      // When the last live consumer leaves before the source has finished — an
      // early `break`, a thrown loop body, or an explicit `.return()` — nobody is
      // listening anymore, so tell the source to stop rather than let it run to
      // completion. With other consumers still attached, the source keeps going.
      if (this.readCursors.size === 0 && !this.finished) {
        this.cancel();
      }
    }
  }

  /**
   * Stop the source and end every consumer's iteration cleanly. Idempotent.
   * A source already drained to completion is unaffected; an in-flight source
   * is told to stop via its async iterator's `return()`.
   */
  cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    const iterator = this.sourceIterator;
    if (iterator?.return !== undefined) {
      // Best-effort: tell the source to stop. We do not await it — cancellation
      // must not block the caller — and a rejected `return()` is not our error
      // to surface, so it is intentionally ignored.
      void Promise.resolve(iterator.return()).catch(() => {
        // Ignore: the source is being torn down; a return() rejection is moot.
      });
    }
    this.wakeConsumers();
    this.wakeProducer();
  }

  /** Start draining the source if it has not already been started. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.drain();
  }

  private absoluteEnd(): number {
    return this.baseOffset + this.buffer.length;
  }

  private async drain(): Promise<void> {
    const iterable = this.source();
    const iterator = iterable[Symbol.asyncIterator]();
    this.sourceIterator = iterator;
    try {
      for (;;) {
        if (this.cancelled) {
          return;
        }
        await this.awaitProducerCapacity();
        if (this.cancelled) {
          return;
        }
        const next = await iterator.next();
        if (next.done === true) {
          return;
        }
        const event = next.value;
        this.buffer.push(event);
        this.onEvent?.(event);
        this.wakeConsumers();
      }
    } catch (error) {
      this.failure = error;
    } finally {
      this.finished = true;
      this.wakeConsumers();
    }
  }

  /**
   * When bounded, pause the producer while the slowest live consumer is still
   * `capacity` events behind. With no live consumers the pause would never lift,
   * so the producer is allowed to run ahead; eviction keeps retention bounded
   * once a consumer starts draining.
   */
  private async awaitProducerCapacity(): Promise<void> {
    if (this.capacity <= NO_CAPACITY || this.readCursors.size === 0) {
      return;
    }
    const unconsumed = this.absoluteEnd() - this.slowestCursorIndex();
    if (unconsumed < this.capacity) {
      return;
    }
    const deferred = Promise.withResolvers<undefined>();
    this.producerWaker = (): void => {
      deferred.resolve(undefined);
    };
    await deferred.promise;
  }

  /** Drop events from the front that every live consumer has already read past. */
  private evictConsumed(): void {
    if (this.readCursors.size === 0) {
      return;
    }
    const slowest = this.slowestCursorIndex();
    while (this.baseOffset < slowest && this.buffer.length > 0) {
      this.buffer.shift();
      this.baseOffset += 1;
    }
  }

  private nextWake(): Promise<undefined> {
    const deferred = Promise.withResolvers<undefined>();
    this.wakers.push(() => {
      deferred.resolve(undefined);
    });
    return deferred.promise;
  }

  private slowestCursorIndex(): number {
    let slowest = this.absoluteEnd();
    for (const cursor of this.readCursors) {
      if (cursor.index < slowest) {
        slowest = cursor.index;
      }
    }
    return slowest;
  }

  private wakeConsumers(): void {
    const pending = this.wakers;
    this.wakers = [];
    for (const resolve of pending) {
      resolve();
    }
  }

  private wakeProducer(): void {
    if (this.capacity <= NO_CAPACITY) {
      return;
    }
    const unconsumed = this.absoluteEnd() - this.slowestCursorIndex();
    if (unconsumed >= this.capacity && this.readCursors.size > 0) {
      return;
    }
    const waker = this.producerWaker;
    if (waker !== undefined) {
      this.producerWaker = undefined;
      waker();
    }
  }
}

const makeReplayEventStream = <Event>(
  options: ReplayEventStreamOptions<Event>
): ReplayEventStream<Event> => new ReplayEventStream(options);

export { makeReplayEventStream, ReplayEventStream };
export type { ReplayEventStreamOptions };
