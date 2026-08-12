import assert from "node:assert/strict";
import test from "node:test";

import { immutableCliRuntime, processCliRuntime } from "@velum-labs/routekit-cli-core";

import { activeCliSession, CliSession, runWithCliSession } from "../cli-session.js";

function session(): CliSession {
  return new CliSession(immutableCliRuntime(processCliRuntime));
}

test("concurrent CLI invocations keep target and telemetry state isolated", async () => {
  const first = session();
  const second = session();
  first.targetSelection = { local: false, remote: "first" };
  second.targetSelection = { local: true };
  first.telemetryTarget = { kind: "remote", client: {} as never };
  second.telemetryTarget = { kind: "local", client: {} as never };

  const [firstState, secondState] = await Promise.all([
    runWithCliSession(first, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = activeCliSession();
      return [current.targetSelection, current.telemetryTarget?.kind] as const;
    }),
    runWithCliSession(second, async () => {
      await Promise.resolve();
      const current = activeCliSession();
      return [current.targetSelection, current.telemetryTarget?.kind] as const;
    })
  ]);

  assert.deepEqual(firstState, [{ local: false, remote: "first" }, "remote"]);
  assert.deepEqual(secondState, [{ local: true }, "local"]);
  assert.throws(() => activeCliSession(), /invocation context is unavailable/);
});
