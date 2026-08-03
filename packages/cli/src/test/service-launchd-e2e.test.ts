import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const launchdEnabled =
  process.platform === "darwin" && process.env.ROUTEKIT_LAUNCHD_ENV_E2E === "1";
const liveAnthropicEnabled =
  process.platform === "darwin" &&
  process.env.ROUTEKIT_LIVE_ANTHROPIC_E2E === "1" &&
  (process.env.ANTHROPIC_API_KEY ?? "").trim().length > 0;

type CliResult = { exitCode: number; stdout: string; stderr: string };

function runCli(
  args: readonly string[],
  input: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<CliResult> {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      { cwd: input.cwd, env: input.env, timeout: 90_000 },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolveRun({ exitCode, stdout, stderr });
      }
    );
  });
}

function json(result: CliResult): Record<string, unknown> {
  if (result.exitCode !== 0) {
    throw new Error(
      `RouteKit CLI exited ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON output\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
}

function launchctl(args: readonly string[]): string {
  return execFileSync("launchctl", [...args], { encoding: "utf8" }).trim();
}

function launchdValue(name: string): string | undefined {
  const value = launchctl(["getenv", name]);
  return value.length > 0 ? value : undefined;
}

function setLaunchdValue(name: string, value: string | undefined): void {
  if (value === undefined) launchctl(["unsetenv", name]);
  else launchctl(["setenv", name, value]);
}

function routekitLaunchdServiceLoaded(): boolean {
  const userId = process.getuid?.();
  if (userId === undefined) return false;
  try {
    launchctl(["print", `gui/${userId}/com.routekit.daemon`]);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function request(
  url: string,
  token: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return await fetch(`${url}${path}`, {
    ...(body === undefined
      ? { headers: { authorization: `Bearer ${token}` } }
      : {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body)
        })
  });
}

function testEnvironment(root: string): {
  home: string;
  stateHome: string;
  project: string;
  env: NodeJS.ProcessEnv;
} {
  const home = join(root, "home");
  const stateHome = join(root, "state");
  const project = join(root, "project");
  mkdirSync(join(home, ".config", "routekit"), { recursive: true });
  mkdirSync(project, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    PORTLESS: "0",
    ROUTEKIT_PORTLESS: "0",
    NO_COLOR: "1"
  };
  delete env.ROUTEKIT_CONFIG;
  delete env.ROUTEKIT_NO_SUPERVISOR;
  return { home, stateHome, project, env };
}

async function cleanupService(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  await runCli(["daemon", "service", "uninstall"], { cwd, env });
}

test("real launchd isolates a configured provider from GUI-domain endpoint variables", {
  skip: !launchdEnabled,
  timeout: 120_000
}, async (context) => {
  if (routekitLaunchdServiceLoaded()) {
    context.skip("com.routekit.daemon is already loaded in the GUI launchd domain");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "routekit-launchd-provider-env-"));
  const { home, stateHome, project, env } = testEnvironment(root);
  const gatewayPort = await freePort();
  const poisonedBaseUrl = `http://127.0.0.1:${gatewayPort}`;
  const previousBaseUrl = launchdValue("ROUTEKIT_CLIPROXY_BASE_URL");
  const previousApiKey = launchdValue("ROUTEKIT_CLIPROXY_API_KEY");
  let upstream = createServer();

  try {
    launchctl(["setenv", "ROUTEKIT_CLIPROXY_BASE_URL", poisonedBaseUrl]);
    launchctl(["setenv", "ROUTEKIT_CLIPROXY_API_KEY", "gui-client-key"]);
    delete env.ROUTEKIT_CLIPROXY_BASE_URL;
    env.ROUTEKIT_CLIPROXY_API_KEY = "daemon-provider-key";
    writeFileSync(
      join(home, ".config", "routekit", "router.yaml"),
      ["providers:", "  cliproxy: {}", "defaultModel: cliproxy/mock-model", ""].join("\n")
    );

    upstream = createServer((request_, response) => {
      assert.equal(request_.headers.authorization, "Bearer daemon-provider-key");
      response.setHeader("content-type", "application/json");
      if (request_.url === "/v1/models") {
        response.end(
          JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] })
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "chatcmpl-launchd",
          object: "chat.completion",
          created: 0,
          model: "mock-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "launchd isolated" },
              finish_reason: "stop"
            }
          ]
        })
      );
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      upstream.once("error", rejectListen);
      upstream.listen(8317, "127.0.0.1", resolveListen);
    });

    const cli = { cwd: project, env };
    const assertGateway = async (url: string): Promise<void> => {
      const token = readFileSync(join(stateHome, "secrets", "data-token"), "utf8").trim();
      const models = await request(url, token, "/v1/models");
      assert.equal(models.status, 200);
      const inference = await request(url, token, "/v1/chat/completions", {
        model: "cliproxy/mock-model",
        messages: [{ role: "user", content: "prove launchd isolation" }]
      });
      assert.equal(inference.status, 200);
      assert.match(await inference.text(), /launchd isolated/);
    };

    const started = json(
      await runCli(["start", "--port", String(gatewayPort), "--no-portless", "--json"], cli)
    );
    assert.equal(started.supervisor, "launchd");
    await assertGateway(started.url as string);

    const restarted = json(await runCli(["daemon", "restart", "--json"], cli));
    assert.notEqual(restarted.pid, started.pid);
    await assertGateway(restarted.url as string);

    const reinstalled = json(
      await runCli(
        ["daemon", "service", "install", "--port", String(gatewayPort), "--no-portless", "--json"],
        cli
      )
    );
    assert.notEqual(reinstalled.pid, restarted.pid);
    await assertGateway(reinstalled.url as string);

    assert.equal(launchdValue("ROUTEKIT_CLIPROXY_BASE_URL"), poisonedBaseUrl);
    assert.equal(launchdValue("ROUTEKIT_CLIPROXY_API_KEY"), "gui-client-key");
  } finally {
    await cleanupService(project, env);
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    setLaunchdValue("ROUTEKIT_CLIPROXY_BASE_URL", previousBaseUrl);
    setLaunchdValue("ROUTEKIT_CLIPROXY_API_KEY", previousApiKey);
    rmSync(root, { recursive: true, force: true });
  }
});

test("real launchd isolates direct Anthropic from native-client GUI variables", {
  skip: !liveAnthropicEnabled,
  timeout: 180_000
}, async (context) => {
  if (routekitLaunchdServiceLoaded()) {
    context.skip("com.routekit.daemon is already loaded in the GUI launchd domain");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "routekit-launchd-anthropic-env-"));
  const { home, stateHome, project, env } = testEnvironment(root);
  const gatewayPort = await freePort();
  const poisonedBaseUrl = `http://127.0.0.1:${gatewayPort}`;
  const previousBaseUrl = launchdValue("ANTHROPIC_BASE_URL");
  const previousAuthToken = launchdValue("ANTHROPIC_AUTH_TOKEN");

  try {
    launchctl(["setenv", "ANTHROPIC_BASE_URL", poisonedBaseUrl]);
    launchctl(["setenv", "ANTHROPIC_AUTH_TOKEN", "gui-client-token"]);
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    writeFileSync(
      join(home, ".config", "routekit", "router.yaml"),
      ["providers:", "  anthropic: {}", ""].join("\n")
    );

    const cli = { cwd: project, env };
    const started = json(
      await runCli(["start", "--port", String(gatewayPort), "--no-portless", "--json"], cli)
    );
    assert.equal(started.supervisor, "launchd");
    const token = readFileSync(join(stateHome, "secrets", "data-token"), "utf8").trim();
    const models = await request(started.url as string, token, "/v1/models");
    assert.equal(models.status, 200);
    const model = ((await models.json()) as { data: Array<{ id: string }> }).data[0]?.id;
    assert.ok(model?.startsWith("anthropic/"));
    const inference = await request(started.url as string, token, "/v1/chat/completions", {
      model,
      messages: [{ role: "user", content: "Reply with ROUTEKIT_ANTHROPIC_ENV_OK" }]
    });
    assert.equal(inference.status, 200);

    const restarted = json(await runCli(["daemon", "restart", "--json"], cli));
    assert.notEqual(restarted.pid, started.pid);
    const postRestart = await request(restarted.url as string, token, "/v1/models");
    assert.equal(postRestart.status, 200);
    assert.equal(launchdValue("ANTHROPIC_BASE_URL"), poisonedBaseUrl);
    assert.equal(launchdValue("ANTHROPIC_AUTH_TOKEN"), "gui-client-token");
  } finally {
    await cleanupService(project, env);
    setLaunchdValue("ANTHROPIC_BASE_URL", previousBaseUrl);
    setLaunchdValue("ANTHROPIC_AUTH_TOKEN", previousAuthToken);
    rmSync(root, { recursive: true, force: true });
  }
});
