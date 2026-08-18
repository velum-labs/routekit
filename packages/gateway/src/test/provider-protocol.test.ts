import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamPump } from "@velum-labs/routekit-runtime/sse";
import {
  decodeAnthropicWebSearchResult,
  decodeOpenAiResponsesEvent,
  decodeOpenAiWebSearchResult,
  decodeToolResult,
  ProviderProtocolError
} from "../providers/protocol.js";

const ENCODER = new TextEncoder();

test("provider boundary decoders reject malformed payloads with typed context", () => {
  assert.throws(() => decodeOpenAiResponsesEvent({ response: {} }), ProviderProtocolError);
  assert.throws(() => decodeToolResult("anthropic", 42), ProviderProtocolError);
});

test("web-search decoders produce canonical tool results and citations", () => {
  const openai = decodeOpenAiWebSearchResult({
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "answer",
            annotations: [{ type: "url_citation", url: "https://example.test/a", title: "A" }]
          }
        ]
      }
    ]
  });
  assert.equal(openai.content, "answer");
  assert.deepEqual(openai.citations, [{ url: "https://example.test/a", title: "A" }]);

  const anthropic = decodeAnthropicWebSearchResult({
    content: [
      { type: "text", text: "answer two" },
      {
        type: "web_search_tool_result",
        content: [{ type: "web_search_result", url: "https://example.test/b", title: "B" }]
      }
    ]
  });
  assert.equal(anthropic.content, "answer two");
  assert.deepEqual(anthropic.citations, [{ url: "https://example.test/b", title: "B" }]);
  assert.deepEqual(anthropic.extensions?.[0]?.value, [
    { type: "web_search_result", url: "https://example.test/b", title: "B" }
  ]);
});

test("StreamPump frames split SSE, emits terminal output, and releases the reader", async () => {
  let canceled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(ENCODER.encode("event: value\nda"));
      controller.enqueue(ENCODER.encode('ta: {"value":1}\n\n'));
      controller.close();
    },
    cancel() {
      canceled = true;
    }
  });
  const output = StreamPump.sse(source, {
    onEvent(event, controller) {
      controller.enqueue(ENCODER.encode(`${event.event}:${event.data}\n`));
    },
    onEnd(controller) {
      controller.enqueue(ENCODER.encode("done\n"));
    }
  });
  assert.equal(await new Response(output).text(), 'value:{"value":1}\ndone\n');
  assert.equal(canceled, false);
  const reader = source.getReader();
  reader.releaseLock();
});

test("StreamPump cancels upstream after a transform failure", async () => {
  let cancelReason: unknown;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(ENCODER.encode("data: {}\n\n"));
    },
    cancel(reason) {
      cancelReason = reason;
    }
  });
  const failure = new Error("decode failed");
  const output = StreamPump.sse(source, {
    onEvent() {
      throw failure;
    },
    onEnd() {}
  });
  await assert.rejects(new Response(output).text(), failure);
  assert.equal(cancelReason, failure);
});

test("StreamPump propagates consumer cancellation and abort signals", async () => {
  let cancelReason: unknown;
  const source = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReason = reason;
    }
  });
  const output = StreamPump.sse(source, { onEvent() {}, onEnd() {} });
  await output.cancel("consumer stopped");
  assert.equal(cancelReason, "consumer stopped");

  let abortReason: unknown;
  const abortSource = new ReadableStream<Uint8Array>({
    cancel(reason) {
      abortReason = reason;
    }
  });
  const abortController = new AbortController();
  const aborted = StreamPump.sse(abortSource, {
    signal: abortController.signal,
    onEvent() {},
    onEnd() {}
  });
  const reader = aborted.getReader();
  abortController.abort("deadline");
  await assert.rejects(reader.read(), (error: unknown) => error === "deadline");
  assert.equal(abortReason, "deadline");
});

test("StreamPump releases its reader when the signal is already aborted", async () => {
  let cancelReason: unknown;
  const source = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReason = reason;
    }
  });
  const abortController = new AbortController();
  abortController.abort("expired");
  const output = StreamPump.sse(source, {
    signal: abortController.signal,
    onEvent() {},
    onEnd() {}
  });
  const reader = output.getReader();
  await assert.rejects(reader.read(), (error: unknown) => error === "expired");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelReason, "expired");
  const upstreamReader = source.getReader();
  upstreamReader.releaseLock();
});

test("StreamPump bytes owns reader cleanup and propagates chunk failures", async () => {
  let canceled: unknown;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(ENCODER.encode("one"));
      controller.enqueue(ENCODER.encode("two"));
    },
    cancel(reason) {
      canceled = reason;
    }
  });
  const failure = new Error("write failed");
  await assert.rejects(
    StreamPump.bytes(source, {
      onChunk() {
        throw failure;
      }
    }),
    failure
  );
  const reader = source.getReader();
  reader.releaseLock();
  assert.equal(canceled, failure);
});
