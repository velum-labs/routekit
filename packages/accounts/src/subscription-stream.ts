import { SseParseError } from "@velum-labs/routekit-gateway";

export const SUBSCRIPTION_SSE_BUFFER_CAP_BYTES = 1024 * 1024;

export async function readSubscriptionWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (signal === undefined) return await reader.read();
  if (signal.aborted) {
    await reader.cancel(signal.reason);
    throw signal.reason ?? new Error("account operation aborted");
  }
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(signal.reason ?? new Error("account operation aborted"));
      void reader.cancel(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function concatSubscriptionBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readBoundedSubscriptionBody(
  body: ReadableStream<Uint8Array>,
  release: () => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await readSubscriptionWithAbort(reader, signal);
      if (next.done) return concatSubscriptionBytes(chunks);
      size += next.value.byteLength;
      if (size > SUBSCRIPTION_SSE_BUFFER_CAP_BYTES) {
        throw new SseParseError(
          `provider SSE body exceeded the ${SUBSCRIPTION_SSE_BUFFER_CAP_BYTES}-byte buffer cap`
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    try {
      if (signal?.aborted !== true) await reader.cancel(error);
    } catch {
    }
    throw error;
  } finally {
    release();
  }
}

export function trackSubscriptionResponseCompletion(
  response: Response,
  release: () => void
): Response {
  if (response.body === null) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}
