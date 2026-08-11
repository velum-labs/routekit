/**
 * A single-consumer async channel: producers `push` values (or `close`), the
 * consumer drains them via `[Symbol.asyncIterator]`. Used by transport-driven
 * drivers (ACP, SSE) to bridge notification callbacks into the `sendTurn`
 * async iterable.
 */
export type AsyncChannelOptions = {
  /** Maximum number of values retained while the consumer is not reading. */
  capacity?: number;
  /** Overflow is explicit: fail the stream or retain only the newest values. */
  overflow?: "error" | "drop-oldest";
  /** Invoked when the consumer returns before the producer closes the stream. */
  onConsumerReturn?: () => void;
};

export class AsyncChannel<T> {
  readonly #queue: T[] = [];
  readonly #capacity: number;
  readonly #overflow: "error" | "drop-oldest";
  readonly #onConsumerReturn: (() => void) | undefined;
  #waiter: ((result: IteratorResult<T>) => void) | undefined;
  #closed = false;
  #error: unknown;

  constructor(options: AsyncChannelOptions = {}) {
    this.#capacity = options.capacity ?? 256;
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity < 1) {
      throw new RangeError("AsyncChannel capacity must be a positive safe integer");
    }
    this.#overflow = options.overflow ?? "error";
    this.#onConsumerReturn = options.onConsumerReturn;
  }

  push(value: T): boolean {
    if (this.#closed) return false;
    if (this.#waiter !== undefined) {
      const resolve = this.#waiter;
      this.#waiter = undefined;
      resolve({ value, done: false });
      return true;
    }
    if (this.#queue.length >= this.#capacity) {
      if (this.#overflow === "drop-oldest") {
        this.#queue.shift();
      } else {
        this.close(new Error(`AsyncChannel capacity ${this.#capacity} exceeded`));
        return false;
      }
    }
    this.#queue.push(value);
    return true;
  }

  close(error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    if (this.#waiter !== undefined) {
      const resolve = this.#waiter;
      this.#waiter = undefined;
      if (error !== undefined) {
        // Surface the error on the next() call site.
        resolve({ value: undefined as never, done: true });
      } else {
        resolve({ value: undefined as never, done: true });
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    let drained = false;
    try {
      for (;;) {
        if (this.#queue.length > 0) {
          yield this.#queue.shift() as T;
          continue;
        }
        if (this.#closed) {
          drained = true;
          if (this.#error !== undefined) throw this.#error;
          return;
        }
        const next = await new Promise<IteratorResult<T>>((resolve) => {
          this.#waiter = resolve;
        });
        if (next.done === true) {
          drained = true;
          if (this.#error !== undefined) throw this.#error;
          return;
        }
        yield next.value;
      }
    } finally {
      if (!drained && !this.#closed) this.#onConsumerReturn?.();
    }
  }
}
