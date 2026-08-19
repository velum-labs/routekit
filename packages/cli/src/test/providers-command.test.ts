import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildProgram } from "../cli.js";
import { child, runProgram } from "./effect-cli-test.js";
import { isModelRouteInfo } from "../effect/commands/models.js";
import { completionCandidates } from "../completion.js";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

async function runJson(args: readonly string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, [CLI_ENTRY, ...args], {
    env: process.env,
    encoding: "utf8"
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function runCliWithInput(input: {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`routekit ${input.args.join(" ")} timed out`));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    child.stdin.end(input.stdin);
  });
}

test("route info validation rejects stale daemon payloads", () => {
  assert.equal(
    isModelRouteInfo({
      id: "openai/gpt-live",
      provider: "openai",
      capabilities: {}
    }),
    false
  );
  assert.equal(
    isModelRouteInfo({
      id: "openai/gpt-live",
      provider: "openai",
      nativeModel: "gpt-live",
      accountClass: "api-key",
      billingMode: "metered-api",
      default: true,
      capabilities: {},
      reasoning: null
    }),
    true
  );
});

test("providers add rejects retained internal providers before daemon work", async () => {
  const providers = child(buildProgram(), "providers");
  const add = child(providers, "add");
  assert.match(add.description ?? "", /first-launch supported provider/);
  assert.doesNotMatch(add.description ?? "", /registry/i);

  await assert.rejects(
    runProgram(buildProgram(), ["providers", "add", "google"]),
    /not offered at first launch.*openai, anthropic, bedrock, openrouter, codex, claude-code/
  );

  await assert.rejects(
    runProgram(buildProgram(), ["providers", "remove", "not-a-provider"]),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /unknown provider.*first-launch providers/);
      assert.doesNotMatch(message, /google|cliproxy/i);
      return true;
    }
  );
});

test("guided setup preflights multiple API routes and persists a live default", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-guided-setup-"));
  const home = join(root, "home");
  const stateHome = join(root, "state");
  mkdirSync(home);
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization === "Bearer openai-test-key") {
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "gpt-live" }]
        })
      );
      return;
    }
    if (request.headers["x-api-key"] === "anthropic-test-key") {
      response.end(
        JSON.stringify({
          data: [{ id: "claude-live", type: "model", display_name: "Claude Live" }]
        })
      );
      return;
    }
    response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const env = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    ROUTEKIT_NO_SUPERVISOR: "1",
    ROUTEKIT_DAEMON_PORT: "0",
    ROUTEKIT_TELEMETRY: "0",
    PORTLESS: "0",
    NO_COLOR: "1",
    OPENAI_API_KEY: "openai-test-key",
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    ANTHROPIC_API_KEY: "anthropic-test-key",
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/v1`,
    OPENROUTER_API_KEY: undefined
  };
  try {
    const result = await runCliWithInput({
      args: ["setup"],
      cwd: root,
      env,
      // Select OpenAI + Anthropic, accept confirmation, then choose the
      // second live model from the combined catalog.
      stdin: "1,2\n\n2\n"
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /checking selected API providers before writing config/i);
    assert.match(output, /Routes\s+openai \(metered-api\), anthropic \(metered-api\)/);
    assert.doesNotMatch(output, /openai-test-key|anthropic-test-key/);

    const config = readFileSync(join(home, ".config", "routekit", "router.yaml"), "utf8");
    assert.match(config, /openai:/);
    assert.match(config, /anthropic:/);
    assert.match(config, /defaultModel: anthropic\/claude-live/);

    await execFileAsync(process.execPath, [CLI_ENTRY, "stop"], {
      cwd: root,
      env,
      encoding: "utf8"
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers and models commands use the live namespaced catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-provider-command-"));
  const home = join(root, "home");
  const configPath = join(home, ".config", "routekit", "router.yaml");
  mkdirSync(join(home, ".config", "routekit"), { recursive: true });
  const previousOsHome = process.env.HOME;
  const previousHome = process.env.ROUTEKIT_HOME;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousPortless = process.env.ROUTEKIT_PORTLESS;
  const previousDaemonPort = process.env.ROUTEKIT_DAEMON_PORT;
  const previousNoSupervisor = process.env.ROUTEKIT_NO_SUPERVISOR;
  let providerHealthy = true;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-key");
    if (!providerHealthy) {
      response.writeHead(503).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: "gpt-live",
            capabilities: { streaming: "supported", tools: "degraded" }
          }
        ]
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(configPath, "providers:\n  openai: {}\ndefaultModel: openai/gpt-live\n");
  process.env.ROUTEKIT_HOME = join(root, "state");
  process.env.HOME = home;
  process.env.ROUTEKIT_PORTLESS = "0";
  process.env.ROUTEKIT_DAEMON_PORT = "0";
  process.env.ROUTEKIT_NO_SUPERVISOR = "1";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const models = await runJson(["--json", "models"]);
    assert.equal(models.defaultModel, "openai/gpt-live");
    assert.deepEqual(models.models, ["openai/gpt-live"]);
    const filtered = await runJson(["--json", "models", "list", "--provider", "openai"]);
    assert.deepEqual(filtered.models, ["openai/gpt-live"]);
    const info = await runJson(["--json", "models", "info", "openai/gpt-live"]);
    assert.deepEqual(info, {
      id: "openai/gpt-live",
      provider: "openai",
      nativeModel: "gpt-live",
      accountClass: "api-key",
      billingMode: "metered-api",
      default: true,
      capabilities: { streaming: "supported", tools: "degraded" },
      reasoning: null
    });
    assert.doesNotMatch(JSON.stringify(info), /test-key/);

    const human = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, "models", "info", "openai/gpt-live"],
      { env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8" }
    );
    const humanOutput = `${human.stdout}\n${human.stderr}`;
    assert.match(humanOutput, /openai\/gpt-live/);
    assert.match(humanOutput, /provider\s+openai/);
    assert.match(humanOutput, /native model\s+gpt-live/);
    assert.match(humanOutput, /account class\s+api-key/);
    assert.match(humanOutput, /billing mode\s+metered-api/);
    assert.match(humanOutput, /default\s+yes/);
    assert.match(humanOutput, /streaming=supported, tools=degraded/);
    assert.match(humanOutput, /reasoning\s+not reported/);
    assert.doesNotMatch(humanOutput, /test-key/);

    await assert.rejects(
      execFileAsync(process.execPath, [CLI_ENTRY, "--json", "models", "info", "openai/not-real"], {
        env: process.env,
        encoding: "utf8"
      }),
      (error: unknown) => {
        const output =
          typeof error === "object" && error !== null && "stdout" in error
            ? String((error as { stdout?: unknown }).stdout)
            : "";
        const failure = JSON.parse(output) as {
          error?: { code?: string; message?: string; try?: string };
        };
        assert.deepEqual(failure, {
          error: {
            code: "model_not_found",
            message: "model is not in the live catalog: openai/not-real",
            try: "routekit models list"
          }
        });
        assert.doesNotMatch(output, /test-key/);
        return true;
      }
    );

    const status = await runJson(["--json", "providers", "status"]);
    assert.deepEqual(
      (status.providers as Array<{ provider: string; models: string[] }>).map((entry) => [
        entry.provider,
        entry.models
      ]),
      [["openai", ["openai/gpt-live"]]]
    );
    assert.deepEqual(completionCandidates(buildProgram(), ["codex", "openai/g"]), [
      "openai/gpt-live"
    ]);

    await runJson(["--json", "providers", "add", "openai", "--strategy", "round_robin"]);
    assert.match(readFileSync(configPath, "utf8"), /strategy: round_robin/);
    providerHealthy = false;
    await assert.rejects(runJson(["--json", "providers", "status"]), (error: unknown) => {
      const stdout =
        typeof error === "object" && error !== null && "stdout" in error
          ? String((error as { stdout?: unknown }).stdout)
          : "";
      assert.match(stdout, /503|discovery/i);
      return true;
    });
    await runJson(["--json", "stop"]);
  } finally {
    if (previousOsHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousOsHome;
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    if (previousPortless === undefined) delete process.env.ROUTEKIT_PORTLESS;
    else process.env.ROUTEKIT_PORTLESS = previousPortless;
    if (previousDaemonPort === undefined) delete process.env.ROUTEKIT_DAEMON_PORT;
    else process.env.ROUTEKIT_DAEMON_PORT = previousDaemonPort;
    if (previousNoSupervisor === undefined) delete process.env.ROUTEKIT_NO_SUPERVISOR;
    else process.env.ROUTEKIT_NO_SUPERVISOR = previousNoSupervisor;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    rmSync(root, { recursive: true, force: true });
  }
});
