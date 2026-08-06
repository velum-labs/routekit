import assert from "node:assert/strict";
import test from "node:test";
import { configureT3, type SupervisorOperations } from "../supervisor.js";

test("pool T3 setup makes restrictive home parents traversable by the service user", () => {
  const actions: Array<{ operation: string; path?: string; args?: string[]; mode?: number }> = [];
  const operations: SupervisorOperations = {
    mkdir(path, options) {
      actions.push({ operation: "mkdir", path, mode: options.mode });
    },
    writeFile(path, _data, options) {
      actions.push({ operation: "writeFile", path, mode: options.mode });
    },
    exists(path) {
      return (
        path === "/home/factory-runner/.config/systemd/user/t3code.service" ||
        path === "/run/user/1234/bus"
      );
    },
    run(binary, args) {
      actions.push({ operation: binary, args });
      return "";
    },
    output(binary, args) {
      actions.push({ operation: binary, args });
      return "1234";
    }
  };

  configureT3("factory-runner", "pool", operations);

  assert.deepEqual(actions.slice(0, 4), [
    { operation: "mkdir", path: "/home/factory-runner", mode: 0o700 },
    { operation: "mkdir", path: "/home/factory-runner/.config", mode: 0o700 },
    {
      operation: "chown",
      args: [
        "factory-runner:factory-runner",
        "/home/factory-runner",
        "/home/factory-runner/.config"
      ]
    },
    {
      operation: "chmod",
      args: ["0700", "/home/factory-runner", "/home/factory-runner/.config"]
    }
  ]);

  const t3 = actions.findIndex(
    (action) => action.operation === "t3" && action.args?.join(" ") === "service install"
  );
  assert.ok(t3 > 3, "home ownership and traversal must be fixed before T3 runs");
});
