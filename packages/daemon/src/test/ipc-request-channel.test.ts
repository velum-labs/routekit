import assert from "node:assert/strict";
import test from "node:test";

import { RequestReplyChannel } from "../ipc-request-channel.js";

type Request = { type: "request"; requestId: string; value: number };
type Response =
  | { type: "response"; requestId: string; ok: true; result: number }
  | { type: "response"; requestId: string; ok: false; error: string };

function channel(send: (request: Request) => void, timeoutMs = 100) {
  return new RequestReplyChannel<Omit<Request, "requestId">, Request, Response>({
    idPrefix: "test",
    timeoutMs,
    encode: (input, requestId) => ({ ...input, requestId }),
    send,
    requestId: (response) => response.requestId,
    decode: (response) =>
      response.ok
        ? { ok: true, value: response.result }
        : { ok: false, error: new Error(response.error) }
  });
}

test("request/reply channel resolves matching responses", async () => {
  let sent: Request | undefined;
  const requests = channel((request) => {
    sent = request;
  });
  const result = requests.request<number>({ type: "request", value: 7 });
  assert.equal(requests.pendingCount, 1);
  assert.equal(
    requests.accept({ type: "response", requestId: sent?.requestId ?? "", ok: true, result: 14 }),
    true
  );
  assert.equal(await result, 14);
  assert.equal(requests.pendingCount, 0);
});

test("request/reply channel rejects protocol failures", async () => {
  let sent: Request | undefined;
  const requests = channel((request) => {
    sent = request;
  });
  const result = requests.request<number>({ type: "request", value: 1 });
  requests.accept({
    type: "response",
    requestId: sent?.requestId ?? "",
    ok: false,
    error: "rejected"
  });
  await assert.rejects(result, /rejected/);
});

test("request/reply channel times out and removes the request", async () => {
  const requests = channel(() => undefined, 5);
  await assert.rejects(requests.request({ type: "request", value: 1 }), /timed out after 5ms/);
  assert.equal(requests.pendingCount, 0);
});

test("request/reply channel aborts one request without closing the channel", async () => {
  const sent: Request[] = [];
  const requests = channel((request) => sent.push(request));
  const abort = new AbortController();
  const aborted = requests.request({ type: "request", value: 1 }, { signal: abort.signal });
  const surviving = requests.request<number>({ type: "request", value: 2 });
  abort.abort(new Error("cancelled"));
  await assert.rejects(aborted, /cancelled/);
  requests.accept({
    type: "response",
    requestId: sent[1]?.requestId ?? "",
    ok: true,
    result: 2
  });
  assert.equal(await surviving, 2);
});

test("request/reply channel close rejects every pending request and is idempotent", async () => {
  const requests = channel(() => undefined);
  const first = requests.request({ type: "request", value: 1 });
  const second = requests.request({ type: "request", value: 2 });
  requests.close(new Error("peer exited"));
  requests.close(new Error("ignored"));
  await assert.rejects(first, /peer exited/);
  await assert.rejects(second, /peer exited/);
  await assert.rejects(requests.request({ type: "request", value: 3 }), /peer exited/);
  assert.equal(requests.pendingCount, 0);
});
