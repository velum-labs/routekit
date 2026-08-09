import assert from "node:assert/strict";
import test from "node:test";
import {
  configureT3,
  inferenceSmoke,
  isMissingLifecycleActionError,
  isT3ServiceHealthy,
  type SupervisorOperations
} from "../supervisor.js";

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

test("inference smoke authenticates both RouteKit data-plane requests", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input.toString();
    requests.push({ url, init });
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "openai/test-model" }] });
    }
    return Response.json({
      output: [{ content: [{ type: "output_text", text: "ROUTEKIT_RUNTIME_READY" }] }]
    });
  };

  await inferenceSmoke(fetchImpl);

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "http://127.0.0.1:8081/v1/models");
  assert.equal(requests[1]?.url, "http://127.0.0.1:8081/v1/responses");
  for (const request of requests) {
    assert.equal(
      new Headers(request.init?.headers).get("authorization"),
      "Bearer routekit-workload"
    );
  }
});

test("inference smoke falls back across providers when the first pool is rate limited", async () => {
  const attemptedModels: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input.toString();
    if (url.endsWith("/v1/models")) {
      return Response.json({
        data: [{ id: "codex/primary" }, { id: "codex/secondary" }, { id: "claude-code/primary" }]
      });
    }
    const body = JSON.parse(String(init?.body)) as { model: string };
    attemptedModels.push(body.model);
    if (body.model.startsWith("codex/")) {
      return Response.json({ error: { type: "rate_limit_error" } }, { status: 429 });
    }
    return Response.json({
      output: [{ content: [{ type: "output_text", text: "ROUTEKIT_RUNTIME_READY" }] }]
    });
  };

  await inferenceSmoke(fetchImpl);

  assert.deepEqual(attemptedModels, ["codex/primary", "claude-code/primary"]);
});

test("completed launch lifecycle replay is idempotent", () => {
  const missing = Object.assign(
    new Error("No active Lifecycle Action found with instance ID i-123"),
    {
      name: "ValidationError"
    }
  );

  assert.equal(isMissingLifecycleActionError(missing), true);
  assert.equal(
    isMissingLifecycleActionError(
      Object.assign(new Error("Access denied"), { name: "AccessDeniedException" })
    ),
    false
  );
});

test("T3 health probes the user service through the runtime service account", () => {
  const calls: Array<{
    binary: string;
    args: string[];
    options?: { user?: string; allowFailure?: boolean };
  }> = [];
  const operations: SupervisorOperations = {
    mkdir() {},
    writeFile() {},
    exists() {
      return false;
    },
    run(binary, args, options) {
      calls.push({ binary, args, options });
      return "active";
    },
    output() {
      return "";
    }
  };

  assert.equal(isT3ServiceHealthy("factory-runner", operations), true);
  assert.deepEqual(calls, [
    {
      binary: "systemctl",
      args: ["--user", "is-active", "t3code.service"],
      options: { user: "factory-runner", allowFailure: true }
    }
  ]);

  operations.run = () => "inactive";
  assert.equal(isT3ServiceHealthy("factory-runner", operations), false);
});
