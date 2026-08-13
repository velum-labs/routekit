import assert from "node:assert/strict";
import test from "node:test";

import { immutableCliRuntime, processCliRuntime } from "@velum-labs/routekit-cli-core";

import { COMMAND_PATHS } from "@velum-labs/routekit-telemetry-core";
import { Effect } from "effect";

import { buildProgram } from "../cli.js";
import { CliSession } from "../cli-session.js";
import { actionableCommandPaths, dottedCommandPath } from "../command-path.js";
import {
  CommandTelemetry,
  captureCommandCompleted,
  isTelemetryExcludedCommand,
  normalizedTelemetryCommand
} from "../command-telemetry.js";

const CANARY = "unique-secret-canary";

function session() {
  return new CliSession(immutableCliRuntime(processCliRuntime));
}

test("normalizes registered paths and excludes recursive/internal commands", () => {
  assert.equal(normalizedTelemetryCommand("providers status"), "providers.status");
  assert.equal(normalizedTelemetryCommand("telemetry status"), undefined);
  assert.equal(normalizedTelemetryCommand("daemon exec"), undefined);
  assert.equal(normalizedTelemetryCommand("daemon run"), undefined);
  assert.equal(normalizedTelemetryCommand("setup"), undefined);
  assert.equal(normalizedTelemetryCommand("token shell"), undefined);
  assert.equal(normalizedTelemetryCommand(`providers status ${CANARY}`), undefined);
});

test("command telemetry paths are the CLI tree minus explicit exclusions", () => {
  const tree = actionableCommandPaths(buildProgram()).map(dottedCommandPath);
  const tracked = tree.filter((path) => !isTelemetryExcludedCommand(path)).sort();
  const extraTree = tracked.filter((path) => !(COMMAND_PATHS as readonly string[]).includes(path));
  const staleAllowlist = COMMAND_PATHS.filter((path) => !tracked.includes(path));
  assert.deepEqual(
    { extraTree, staleAllowlist },
    { extraTree: [], staleAllowlist: [] },
    "add a new CLI command to COMMAND_PATHS or TELEMETRY_EXCLUDED_COMMANDS; remove stale telemetry paths"
  );
});

test("command telemetry uses only an already-resolved client and excludes raw inputs", async () => {
  const invocation = session();
  const calls: unknown[] = [];
  invocation.telemetryTarget = {
    kind: "local",
    client: {
      call: (...args: unknown[]) => {
        calls.push(args);
        return Effect.succeed({ accepted: true });
      }
    } as never
  };
  assert.equal(
    await captureCommandCompleted(
      { path: "providers status", startedAt: 0 },
      "success",
      500,
      invocation
    ),
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

  invocation.telemetryTarget = undefined;
  assert.equal(
    await captureCommandCompleted(
      { path: "providers status", startedAt: 0 },
      "success",
      500,
      invocation
    ),
    false
  );
});

test("command telemetry transport failures are isolated", async () => {
  const invocation = session();
  invocation.telemetryTarget = {
    kind: "remote",
    client: {
      call: () => Effect.fail(new Error(CANARY))
    } as never
  };
  assert.equal(
    await captureCommandCompleted(
      { path: "status", startedAt: 0 },
      "command_error",
      500,
      invocation
    ),
    false
  );
});

test("postAction and catch completion paths emit exactly once for success and failure", async () => {
  for (const exitKind of ["success", "command_error"] as const) {
    const invocation = session();
    const calls: unknown[] = [];
    invocation.telemetryTarget = {
      kind: "local",
      client: {
        call: (...args: unknown[]) => {
          calls.push(args);
          return Effect.succeed({ accepted: true });
        }
      } as never
    };
    const telemetry = new CommandTelemetry(invocation);
    telemetry.begin("status", 0);
    assert.equal(await telemetry.finish(exitKind), true);
    assert.equal(await telemetry.finish(exitKind), false);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as unknown[])[0], "telemetry.captureCommand");
  }
});
