import { SseDecoder, SseParseError } from "@velum-labs/routekit-runtime";

import type { SubscriptionFailure } from "./types.js";

export const SUBSCRIPTION_SSE_BUFFER_CAP_BYTES = 1024 * 1024;

export type SubscriptionStreamEventResult = {
  semanticOutput?: boolean;
  failure?: SubscriptionFailure;
};

export type SubscriptionStreamEventObserver = (input: {
  event: string | undefined;
  payload: unknown;
}) => SubscriptionStreamEventResult | undefined;

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
    } catch {}
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

function inspectSubscriptionSseBytes(
  bytes: Uint8Array,
  observe: SubscriptionStreamEventObserver
): SubscriptionStreamEventResult {
  const decoder = new SseDecoder();
  let semanticOutput = false;
  let failure: SubscriptionFailure | undefined;
  const events = [...decoder.feed(bytes), ...decoder.flush()];
  for (const event of events) {
    const raw = event.data.trim();
    if (raw.length === 0 || raw === "[DONE]") continue;
    const result = observe({ event: event.event, payload: JSON.parse(raw) });
    if (result?.semanticOutput === true) semanticOutput = true;
    if (result?.failure !== undefined) failure = result.failure;
  }
  return {
    ...(semanticOutput ? { semanticOutput } : {}),
    ...(failure !== undefined ? { failure } : {})
  };
}

export async function inspectSubscriptionResponse(input: {
  response: Response;
  responseMode: "buffered" | "streaming";
  release: () => void;
  signal?: AbortSignal;
  observe: SubscriptionStreamEventObserver;
  onTerminalFailure?: (failure: SubscriptionFailure) => void | Promise<void>;
}): Promise<{ response: Response; failure?: SubscriptionFailure }> {
  const { response, responseMode, release, signal, observe, onTerminalFailure } = input;
  if (
    response.body === null ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    return { response: trackSubscriptionResponseCompletion(response, release) };
  }
  if (responseMode === "buffered") {
    const bytes = await readBoundedSubscriptionBody(response.body, release, signal);
    const outcome = inspectSubscriptionSseBytes(bytes, observe);
    const replay = new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
    if (outcome.failure !== undefined) return { response: replay, failure: outcome.failure };
    return { response: replay };
  }

  const reader = response.body.getReader();
  const decoder = new SseDecoder();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let terminalFailure: SubscriptionFailure | undefined;
  let terminalFailureApplied = false;
  let semanticOutput = false;
  const inspect = (chunk: Uint8Array): void => {
    for (const event of decoder.feed(chunk)) {
      const raw = event.data.trim();
      if (raw.length === 0 || raw === "[DONE]") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        continue;
      }
      const result = observe({ event: event.event, payload });
      if (result?.semanticOutput === true) semanticOutput = true;
      if (result?.failure !== undefined) terminalFailure = result.failure;
    }
  };
  const applyTerminalFailure = async (): Promise<void> => {
    if (
      terminalFailureApplied ||
      terminalFailure === undefined ||
      onTerminalFailure === undefined
    ) {
      return;
    }
    terminalFailureApplied = true;
    await onTerminalFailure(terminalFailure);
  };

  while (!semanticOutput && terminalFailure === undefined) {
    const next = await readSubscriptionWithAbort(reader, signal);
    if (next.done) {
      try {
        decoder.flush();
      } finally {
        release();
      }
      break;
    }
    buffered.push(next.value);
    bufferedBytes += next.value.byteLength;
    if (bufferedBytes > SUBSCRIPTION_SSE_BUFFER_CAP_BYTES) {
      await reader.cancel("RouteKit SSE prelude exceeded 1 MiB");
      release();
      throw new SseParseError("provider SSE prelude exceeded the 1 MiB retry buffer cap");
    }
    inspect(next.value);
  }
  if (terminalFailure !== undefined && semanticOutput) await applyTerminalFailure();
  if (terminalFailure !== undefined && !semanticOutput) {
    await reader.cancel();
    release();
    return {
      response: new Response(concatSubscriptionBytes(buffered), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      }),
      failure: terminalFailure
    };
  }

  let prefix = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (prefix < buffered.length) {
          controller.enqueue(buffered[prefix++]!);
          return;
        }
        const next = await readSubscriptionWithAbort(reader, signal);
        if (next.done) {
          try {
            decoder.flush();
          } finally {
            release();
          }
          controller.close();
          return;
        }
        inspect(next.value);
        if (terminalFailure !== undefined) await applyTerminalFailure();
        controller.enqueue(next.value);
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
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  };
}
