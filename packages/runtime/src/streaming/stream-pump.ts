import { SseDecoder, type SseEvent } from "./sse.js";

export type SseTransformOptions = {
  signal?: AbortSignal;
  keepaliveMs?: number;
  onStart?(controller: ReadableStreamDefaultController<Uint8Array>): void | Promise<void>;
  onEvent(
    event: SseEvent,
    controller: ReadableStreamDefaultController<Uint8Array>
  ): void | Promise<void>;
  onEnd(controller: ReadableStreamDefaultController<Uint8Array>): void | Promise<void>;
  keepalive?(controller: ReadableStreamDefaultController<Uint8Array>): void;
};

/**
 * The single ownership point for upstream byte and SSE readers.
 *
 * It honors downstream backpressure, propagates cancellation and aborts,
 * frames partial SSE chunks through SseDecoder, attempts reader cancellation
 * after transform failures, and always releases the reader lock.
 */
export class StreamPump {
  static async bytes(
    source: ReadableStream<Uint8Array>,
    options: {
      signal?: AbortSignal;
      onChunk(chunk: Uint8Array): void | Promise<void>;
    }
  ): Promise<void> {
    const reader = source.getReader();
    const onAbort = (): void => {
      void reader.cancel(options.signal?.reason).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (options.signal?.aborted === true) {
        await reader.cancel(options.signal.reason);
        return;
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value !== undefined) await options.onChunk(value);
      }
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // Preserve the consumer/transform failure.
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  }

  static sse(
    source: ReadableStream<Uint8Array>,
    options: SseTransformOptions
  ): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    const decoder = new SseDecoder();
    let wakePull: (() => void) | undefined;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    let settled = false;

    const wake = (): void => {
      wakePull?.();
      wakePull = undefined;
    };
    const awaitCapacity = async (
      controller: ReadableStreamDefaultController<Uint8Array>
    ): Promise<void> => {
      while (!settled && (controller.desiredSize ?? 1) <= 0) {
        await new Promise<void>((resolve) => {
          wakePull = resolve;
        });
      }
    };
    const stopKeepalive = (): void => {
      if (keepaliveTimer !== undefined) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = undefined;
      }
    };

    let abort: (() => void) | undefined;
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      stopKeepalive();
      wake();
      if (abort !== undefined && options.signal !== undefined) {
        options.signal.removeEventListener("abort", abort);
      }
      reader.releaseLock();
    };

    const pump = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
      try {
        await options.onStart?.(controller);
        for (;;) {
          await awaitCapacity(controller);
          if (settled) return;
          const { done, value } = await reader.read();
          if (done) {
            for (const event of decoder.flush()) await options.onEvent(event, controller);
            await options.onEnd(controller);
            settled = true;
            stopKeepalive();
            controller.close();
            return;
          }
          if (value !== undefined) {
            for (const event of decoder.feed(value)) await options.onEvent(event, controller);
          }
        }
      } catch (error) {
        if (settled) return;
        settled = true;
        stopKeepalive();
        try {
          await reader.cancel(error);
        } catch {
          // The transform error remains authoritative.
        }
        controller.error(error);
      } finally {
        cleanup();
      }
    };

    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (options.signal !== undefined) {
          abort = () => {
            if (settled) return;
            settled = true;
            stopKeepalive();
            wake();
            const reason = options.signal?.reason ?? new DOMException("Aborted", "AbortError");
            void reader
              .cancel(reason)
              .catch(() => undefined)
              .finally(cleanup);
            controller.error(reason);
          };
          if (options.signal.aborted) abort();
          else options.signal.addEventListener("abort", abort, { once: true });
        }
        if (
          options.keepalive !== undefined &&
          options.keepaliveMs !== undefined &&
          options.keepaliveMs > 0
        ) {
          keepaliveTimer = setInterval(() => {
            if (settled || (controller.desiredSize ?? 1) <= 0) return;
            try {
              options.keepalive?.(controller);
            } catch {
              // A closed controller is settled by the active pump/cancel path.
            }
          }, options.keepaliveMs);
        }
        if (!settled) void pump(controller);
      },
      pull() {
        wake();
      },
      async cancel(reason) {
        if (settled) return;
        settled = true;
        stopKeepalive();
        wake();
        try {
          await reader.cancel(reason);
        } finally {
          cleanup();
        }
      }
    });
  }

  /**
   * Pump raw SSE frames when an adapter must preserve comments, line endings,
   * and unknown fields byte-for-byte while rewriting only selected data.
   */
  static frames(
    source: ReadableStream<Uint8Array>,
    options: {
      signal?: AbortSignal;
      onFrame(
        frame: string,
        delimiter: string,
        controller: ReadableStreamDefaultController<Uint8Array>
      ): void | Promise<void>;
      onEnd(controller: ReadableStreamDefaultController<Uint8Array>): void | Promise<void>;
    }
  ): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let settled = false;
    let cleaned = false;
    let wakePull: (() => void) | undefined;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      if (abort !== undefined && options.signal !== undefined) {
        options.signal.removeEventListener("abort", abort);
      }
      reader.releaseLock();
    };
    const wake = (): void => {
      wakePull?.();
      wakePull = undefined;
    };
    const pump = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
      try {
        for (;;) {
          while (!settled && (controller.desiredSize ?? 1) <= 0) {
            await new Promise<void>((resolve) => {
              wakePull = resolve;
            });
          }
          if (settled) return;
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.length > 0) await options.onFrame(buffer, "", controller);
            await options.onEnd(controller);
            settled = true;
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const match = /\r?\n\r?\n/.exec(buffer);
            if (match === null || match.index === undefined) break;
            const frame = buffer.slice(0, match.index);
            const delimiter = match[0];
            buffer = buffer.slice(match.index + delimiter.length);
            await options.onFrame(frame, delimiter, controller);
          }
        }
      } catch (error) {
        if (settled) return;
        settled = true;
        try {
          await reader.cancel(error);
        } catch {
          // The transform failure remains authoritative.
        }
        controller.error(error);
      } finally {
        cleanup();
      }
    };
    let abort: (() => void) | undefined;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (options.signal !== undefined) {
          abort = () => {
            if (settled) return;
            settled = true;
            wake();
            const reason = options.signal?.reason ?? new DOMException("Aborted", "AbortError");
            void reader
              .cancel(reason)
              .catch(() => undefined)
              .finally(cleanup);
            controller.error(reason);
          };
          if (options.signal.aborted) abort();
          else options.signal.addEventListener("abort", abort, { once: true });
        }
        if (!settled) void pump(controller);
      },
      pull() {
        wake();
      },
      async cancel(reason) {
        if (settled) return;
        settled = true;
        wake();
        try {
          await reader.cancel(reason);
        } finally {
          cleanup();
        }
      }
    });
  }
}

/** Descriptive entry point used by protocol adapters. */
export const SseTransform = StreamPump;
