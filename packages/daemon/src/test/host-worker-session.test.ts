import assert from "node:assert/strict";
import type { Worker } from "node:cluster";
import test from "node:test";

import { HostWorkerCoordinator } from "../host-worker-session.js";

function fakeWorker(id: number): Worker {
  return { id } as Worker;
}

function coordinator() {
  return new HostWorkerCoordinator({
    env: {},
    controlToken: "token",
    controlPort: 1,
    dataPort: 2,
    dataUrl: () => "http://127.0.0.1:2",
    hostStartedAt: "2026-01-01T00:00:00.000Z",
    drainGraceMs: 1_000
  });
}

test("host worker coordinator consumes worker ready and response IPC", () => {
  const workers = coordinator();
  const worker = fakeWorker(7);
  assert.equal(
    workers.accept(worker, {
      type: "worker.ready",
      protocolVersion: 2,
      workerPid: 1,
      workerStartedAt: "2026-01-01T00:00:00.000Z",
      packageVersion: "0.0.0",
      generation: 1,
      configRevision: 1,
      accountRevision: 1,
      configHash: "hash",
      controlUrl: "http://127.0.0.1:1",
      controlPort: 1,
      dataUrl: "http://127.0.0.1:2",
      dataPort: 2
    }),
    true
  );
  assert.equal(
    workers.accept(worker, {
      type: "worker.response",
      requestId: "host-7-1",
      ok: true
    }),
    true
  );
});

test("host worker coordinator leaves host-directed messages to the daemon host", () => {
  const workers = coordinator();
  const worker = fakeWorker(7);
  assert.equal(workers.accept(worker, { type: "host.shutdown", reason: "stop" }), false);
  assert.equal(
    workers.accept(worker, {
      type: "host.roll",
      requestId: "1",
      params: { reason: "restart", expectedGeneration: 1 }
    }),
    false
  );
  assert.equal(
    workers.accept(worker, {
      type: "host.sidecar",
      requestId: "1",
      operation: "status"
    }),
    false
  );
});
