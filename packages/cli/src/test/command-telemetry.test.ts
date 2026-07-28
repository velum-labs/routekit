import assert from "node:assert/strict";
import test from "node:test";

import {
  beginCommandTelemetry,
  captureCommandCompleted,
  finishCommandTelemetry,
  normalizedTelemetryCommand,
  resetCommandTelemetryForTest
} from "../command-telemetry.js";
import { setTelemetryTargetForTest } from "../client.js";

const CANARY = "unique-secret-canary";

test("normalizes registered paths and excludes recursive/internal commands", () => {
  assert.equal(normalizedTelemetryCommand("providers status"), "providers.status");
  assert.equal(normalizedTelemetryCommand("telemetry status"), undefined);
  assert.equal(normalizedTelemetryCommand("daemon exec"), undefined);
  assert.equal(normalizedTelemetryCommand("daemon run"), undefined);
  assert.equal(normalizedTelemetryCommand(`providers status ${CANARY}`), undefined);
});

test("command telemetry uses only an already-resolved client and excludes raw inputs", async () => {
  const calls: unknown[] = [];
  setTelemetryTargetForTest({
    kind: "local",
    client: {
      call: async (...args: unknown[]) => {
        calls.push(args);
        return { accepted: true };
      }
    } as never
  });
  assert.equal(
    await captureCommandCompleted({ path: "providers status", startedAt: 0 }, "success", 500),
    true
  );
  assert.equal(calls.length, 1);
  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /argv|cwd|remote|host|url|error|unique-secret-canary/i);
  assert.match(serialized, /providers\.status/);
  assert.ok(
    ((calls[0] as unknown[])[2] as { signal?: unknown }).signal instanceof AbortSignal,
    "best-effort telemetry must use a dedicated timeout signal"
  );

  setTelemetryTargetForTest(undefined);
  assert.equal(
    await captureCommandCompleted({ path: "providers status", startedAt: 0 }, "success", 500),
    false
  );
});

test("command telemetry transport failures are isolated", async () => {
  setTelemetryTargetForTest({
    kind: "remote",
    client: {
      call: async () => {
        throw new Error(CANARY);
      }
    } as never
  });
  assert.equal(
    await captureCommandCompleted({ path: "status", startedAt: 0 }, "command_error", 500),
    false
  );
  setTelemetryTargetForTest(undefined);
});

test("postAction and catch completion paths emit exactly once for success and failure", async () => {
  for (const exitKind of ["success", "command_error"] as const) {
    const calls: unknown[] = [];
    setTelemetryTargetForTest({
      kind: "local",
      client: {
        call: async (...args: unknown[]) => {
          calls.push(args);
          return { accepted: true };
        }
      } as never
    });
    beginCommandTelemetry("status", 0);
    assert.equal(await finishCommandTelemetry(exitKind), true);
    assert.equal(await finishCommandTelemetry(exitKind), false);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as unknown[])[0], "telemetry.captureCommand");
  }
  resetCommandTelemetryForTest();
  setTelemetryTargetForTest(undefined);
});
