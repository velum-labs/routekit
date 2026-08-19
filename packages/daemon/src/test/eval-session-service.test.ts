import assert from "node:assert/strict";
import test from "node:test";
import { ManagedRuntime } from "effect";

import { EvalSessionManager, EvalSessions } from "../services/eval-session/service.js";

const limits = {
  calls: 2,
  inputTokens: 10_000,
  outputTokens: 12,
  perCallOutputTokens: 8,
  wallTimeMs: 60_000
};

test("eval sessions are ephemeral, model-restricted, and close idempotently", () => {
  let now = Date.parse("2026-08-18T00:00:00.000Z");
  let sequence = 0;
  const sessions = new EvalSessionManager({
    now: () => now,
    random: (bytes) => Buffer.alloc(bytes, ++sequence)
  });
  const opened = sessions.open({
    purpose: "qualification",
    operationId: "run-1",
    allowedModels: ["openai/gpt-5.6-luna"],
    limits,
    expiresInSeconds: 30,
    gatewayUrl: "http://127.0.0.1:8080",
    targetIdentity: "routekit-generation:1"
  });

  assert.equal(opened.expiresAt, "2026-08-18T00:00:30.000Z");
  const principal = sessions.resolve(opened.bearerCredential);
  assert.equal(principal?.role, "eval");
  assert.deepEqual(principal?.evalSession?.allowedModels, ["openai/gpt-5.6-luna"]);
  assert.deepEqual(principal?.evalSession?.admit?.("openai/gpt-5.6-luna", 100, 8), {
    admitted: true
  });
  assert.deepEqual(principal?.evalSession?.admit?.("openai/gpt-5.6-sol", 100, 1), {
    admitted: false,
    reason: "closed"
  });

  assert.equal(sessions.close(opened.sessionId), true);
  assert.equal(sessions.close(opened.sessionId), false);
  assert.equal(sessions.resolve(opened.bearerCredential), undefined);

  now += 1;
});

test("eval session admission enforces call, input, output, and expiry limits", () => {
  let now = 0;
  let sequence = 10;
  const sessions = new EvalSessionManager({
    now: () => now,
    random: (bytes) => Buffer.alloc(bytes, ++sequence)
  });
  const opened = sessions.open({
    purpose: "authoring",
    operationId: "proposal-1",
    allowedModels: ["openai/gpt-5.6-terra"],
    limits,
    expiresInSeconds: 120,
    gatewayUrl: "http://127.0.0.1:8080",
    targetIdentity: "routekit-generation:1"
  });
  const admit = sessions.resolve(opened.bearerCredential)?.evalSession?.admit;
  assert.ok(admit !== undefined);
  assert.deepEqual(admit("openai/gpt-5.6-terra", 4_000, 8), { admitted: true });
  assert.deepEqual(admit("openai/gpt-5.6-terra", 1, 5), {
    admitted: false,
    reason: "output_limit"
  });
  assert.deepEqual(admit("openai/gpt-5.6-terra", 6_001, 1), {
    admitted: false,
    reason: "input_limit"
  });
  assert.deepEqual(admit("openai/gpt-5.6-terra", 6_000, 4), { admitted: true });
  assert.deepEqual(admit("openai/gpt-5.6-terra", 0, 1), {
    admitted: false,
    reason: "call_limit"
  });

  now = 60_000;
  assert.equal(sessions.resolve(opened.bearerCredential), undefined);
});

test("eval sessions close when their Effect-owned daemon scope is disposed", async () => {
  let sequence = 20;
  const runtime = ManagedRuntime.make(
    EvalSessions.layer({
      now: () => 0,
      random: (bytes) => Buffer.alloc(bytes, ++sequence)
    })
  );
  const sessions = await runtime.runPromise(EvalSessions);
  const opened = sessions.open({
    purpose: "qualification",
    operationId: "restart-1",
    allowedModels: ["openai/gpt-5.6-luna"],
    limits,
    expiresInSeconds: 120,
    gatewayUrl: "http://127.0.0.1:8080",
    targetIdentity: "routekit-generation:1"
  });
  assert.equal(sessions.resolve(opened.bearerCredential)?.role, "eval");

  await runtime.dispose();

  assert.equal(sessions.resolve(opened.bearerCredential), undefined);
});

test("a restarted eval-session layer cannot authenticate an old bearer", async () => {
  let firstSequence = 30;
  const firstRuntime = ManagedRuntime.make(
    EvalSessions.layer({
      now: () => 0,
      random: (bytes) => Buffer.alloc(bytes, ++firstSequence)
    })
  );
  const first = await firstRuntime.runPromise(EvalSessions);
  const opened = first.open({
    purpose: "qualification",
    operationId: "restart-old-bearer",
    allowedModels: ["openai/gpt-5.6-luna"],
    limits,
    expiresInSeconds: 120,
    gatewayUrl: "http://127.0.0.1:8080",
    targetIdentity: "routekit-generation:1"
  });
  await firstRuntime.dispose();

  let secondSequence = 60;
  const secondRuntime = ManagedRuntime.make(
    EvalSessions.layer({
      now: () => 0,
      random: (bytes) => Buffer.alloc(bytes, ++secondSequence)
    })
  );
  const second = await secondRuntime.runPromise(EvalSessions);
  assert.equal(second.resolve(opened.bearerCredential), undefined);
  await secondRuntime.dispose();
});
