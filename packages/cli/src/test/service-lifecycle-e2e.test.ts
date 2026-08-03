import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

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
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON output\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer!: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not occur within ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function authenticatedRequest(
  url: string,
  token: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return await fetch(`${url}${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body)
        }),
    ...(body === undefined ? { headers: { authorization: `Bearer ${token}` } } : {})
  });
}

test("public RouteKit lifecycle: start, idempotency, upgrade, drain-on-stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-service-e2e-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const stateHome = join(root, "state");
  mkdirSync(join(home, ".config", "routekit"), { recursive: true });
  mkdirSync(project, { recursive: true });

  // Keep the mock completion in flight until the test observes draining. This
  // avoids coupling the assertion to CLI process startup time under load.
  let markSlowRequestStarted!: () => void;
  const slowRequestStarted = new Promise<void>((resolveStarted) => {
    markSlowRequestStarted = resolveStarted;
  });
  let releaseSlowResponse!: () => void;
  const slowResponseReleased = new Promise<void>((resolveReleased) => {
    releaseSlowResponse = resolveReleased;
  });
  const drainObservationTimeoutMs = 10_000;
  const upstream = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] })
      );
      return;
    }
    request.on("data", () => {});
    request.on("end", () => {
      markSlowRequestStarted();
      const respond = (): void => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "chatcmpl-e2e",
            object: "chat.completion",
            created: 0,
            model: "mock-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "drained answer" },
                finish_reason: "stop"
              }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        );
      };
      void slowResponseReleased.then(respond);
    });
  });
  await new Promise<void>((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const configPath = join(home, ".config", "routekit", "router.yaml");
  writeFileSync(
    configPath,
    ["providers:", "  openai: {}", "defaultModel: openai/mock-model", ""].join("\n")
  );
  const env = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    OPENAI_API_KEY: "mock-secret",
    OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    PORTLESS: "0",
    ROUTEKIT_PORTLESS: "0",
    ROUTEKIT_NO_SUPERVISOR: "1",
    NO_COLOR: "1"
  };
  const cli = { cwd: project, env };
  const recordPath = join(stateHome, "services", "daemon.json");
  let daemonPid: number | undefined;
  let hostPid: number | undefined;

  try {
    // start: detached daemon, readiness-verified, record written.
    const started = json(
      await runCli(["start", "--port", "0", "--no-portless", "--drain-grace", "5", "--json"], cli)
    );
    assert.equal(started.alreadyRunning, false);
    assert.equal(started.supervisor, "detached");
    daemonPid = started.pid as number;
    hostPid = started.hostPid as number;
    assert.ok(alive(daemonPid));
    assert.ok(alive(hostPid));
    assert.ok(existsSync(recordPath));
    const url = started.url as string;
    assert.equal((await fetch(`${url}/health`)).status, 200);

    // start again: idempotent, same daemon.
    const again = json(await runCli(["start", "--port", "0", "--no-portless", "--json"], cli));
    assert.equal(again.alreadyRunning, true);
    assert.equal(again.pid, daemonPid);

    // The record carries the stamps the upgrade flow relies on.
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      version?: string;
      args?: string[];
      supervisor?: string;
      authTokenFile?: string;
    };
    assert.equal(typeof record.version, "string");
    assert.equal(record.supervisor, "detached");
    assert.ok(record.args?.includes("run"));
    assert.ok(record.authTokenFile !== undefined);
    const dataToken = readFileSync(record.authTokenFile, "utf8").trim();
    assert.equal(record.args?.join(" ").includes(dataToken), false);

    // Upgrade without skew is a no-op; --force rolls the request-serving worker.
    const upToDate = json(await runCli(["daemon", "upgrade", "--json"], cli));
    assert.equal(upToDate.action, "up-to-date");
    let polling = true;
    const trafficErrors: string[] = [];
    const traffic = (async () => {
      while (polling) {
        try {
          const response = await authenticatedRequest(url, dataToken, "/v1/models");
          if (response.status !== 200) trafficErrors.push(`status ${response.status}`);
        } catch (error) {
          trafficErrors.push(error instanceof Error ? error.message : String(error));
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    })();
    const upgradeRun = await runCli(
      ["daemon", "upgrade", "--force", "--drain-grace", "5", "--json"],
      cli
    );
    polling = false;
    await traffic;
    const upgraded = json(upgradeRun);
    assert.equal(upgraded.action, "rolling-upgrade");
    assert.equal(upgraded.previousPid, daemonPid);
    assert.notEqual(upgraded.pid, daemonPid);
    assert.equal(upgraded.hostPid, hostPid);
    assert.equal(upgraded.url, url);
    assert.deepEqual(trafficErrors, []);
    await within(
      (async () => {
        while (daemonPid !== undefined && alive(daemonPid)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      })(),
      6_000,
      "retiring worker exit"
    );
    daemonPid = upgraded.pid as number;
    const upgradedUrl = upgraded.url as string;
    assert.equal((await fetch(`${upgradedUrl}/health`)).status, 200);

    // logs: the daemon's output landed in the shared log file.
    const logs = await runCli(["daemon", "logs", "-n", "50"], cli);
    assert.equal(logs.exitCode, 0);
    assert.match(logs.stdout, /RouteKit daemon listening/);

    // Drain on stop: an in-flight (slow) completion finishes while the
    // gateway refuses new work and then shuts down.
    const inflight = fetch(`${upgradedUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${dataToken}`
      },
      body: JSON.stringify({
        model: "openai/mock-model",
        messages: [{ role: "user", content: "slow" }]
      })
    }).then(
      (response) => ({ response }),
      (error: unknown) => ({ error })
    );
    await within(slowRequestStarted, 5_000, "slow upstream request");
    const stopRun = runCli(["stop", "--json"], cli);
    let healthStatus = 200;
    // Starting a fresh Node CLI can take several seconds when the workspace
    // test matrix saturates a small CI runner.
    const drainDeadline = Date.now() + drainObservationTimeoutMs;
    while (healthStatus !== 503 && Date.now() < drainDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      try {
        healthStatus = (await fetch(`${upgradedUrl}/health`)).status;
      } catch {
        healthStatus = 0;
      }
    }
    assert.equal(healthStatus, 503);
    const rejected = await fetch(`${upgradedUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${dataToken}`
      },
      body: JSON.stringify({
        model: "openai/mock-model",
        messages: [{ role: "user", content: "new work during drain" }]
      })
    });
    assert.equal(rejected.status, 503);
    releaseSlowResponse();
    const inflightOutcome = await inflight;
    if ("error" in inflightOutcome) throw inflightOutcome.error;
    const inflightResponse = inflightOutcome.response;
    assert.equal(inflightResponse.status, 200);
    assert.match(await inflightResponse.text(), /drained answer/);
    const stopped = json(await stopRun);
    assert.equal(stopped.stopped, true);
    // Guarded cleanup intentionally leaves the dead generation record in
    // place rather than risking deletion of a concurrently published
    // successor; readers treat its dead pid as unavailable.
    assert.equal((JSON.parse(readFileSync(recordPath, "utf8")) as { pid: number }).pid, hostPid);
    const deadline = Date.now() + 5_000;
    while (alive(daemonPid) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.equal(alive(daemonPid), false);
    daemonPid = undefined;
    const stoppedAgain = json(await runCli(["stop", "--json"], cli));
    assert.equal(stoppedAgain.stopped, false);

    // Hidden legacy commands remain compatible for existing automation.
    const legacyStarted = json(
      await runCli(["daemon", "start", "--port", "0", "--no-portless", "--json"], cli)
    );
    daemonPid = legacyStarted.pid as number;
    const legacyStatus = json(await runCli(["daemon", "status", "--json"], cli));
    assert.equal(legacyStatus.pid, daemonPid);
    assert.equal(legacyStatus.dataUrl, legacyStarted.url);
    const legacyStopped = json(await runCli(["daemon", "stop", "--json"], cli));
    assert.equal(legacyStopped.stopped, true);
    assert.equal(legacyStopped.pid, legacyStarted.hostPid);
    assert.equal(alive(daemonPid), false);
    daemonPid = undefined;
  } finally {
    releaseSlowResponse();
    if (daemonPid !== undefined && alive(daemonPid)) {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * PATH shim to the committed fake-supervisor fixture. On restart the fixture
 * stops the old daemon and re-execs the unit/plist command line.
 */
function writeFakeSupervisor(
  bin: string,
  home: string,
  managerEnv: NodeJS.ProcessEnv = {}
): "systemd" | "launchd" {
  const kind = process.platform === "darwin" ? "launchd" : "systemd";
  const fixture = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "test",
    "fixtures",
    "fake-supervisor.mjs"
  );
  const statePath = join(bin, "supervisor-state.json");
  const script = join(bin, kind === "launchd" ? "launchctl" : "systemctl");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `export FAKE_SUPERVISOR_HOME=${JSON.stringify(home)}`,
      `export FAKE_SUPERVISOR_STATE=${JSON.stringify(statePath)}`,
      `export FAKE_SUPERVISOR_KIND=${JSON.stringify(kind)}`,
      `export FAKE_SUPERVISOR_ENV=${JSON.stringify(JSON.stringify(managerEnv))}`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"`
    ].join("\n") + "\n",
    { mode: 0o755 }
  );
  chmodSync(script, 0o755);
  if (kind === "systemd") {
    const loginctl = join(bin, "loginctl");
    writeFileSync(loginctl, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(loginctl, 0o755);
  }
  return kind;
}

test("supervised daemon isolates provider endpoints inherited from the manager", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-supervised-provider-env-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const stateHome = join(root, "state");
  const bin = join(root, "bin");
  const gatewayPort = await freePort();
  mkdirSync(join(home, ".config", "routekit"), { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const poisonedBaseUrl = `http://127.0.0.1:${gatewayPort}`;
  const expectedSupervisor = writeFakeSupervisor(bin, home, {
    ROUTEKIT_CLIPROXY_BASE_URL: poisonedBaseUrl,
    ROUTEKIT_CLIPROXY_API_KEY: "manager-client-key"
  });

  const upstream = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer daemon-provider-key");
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] })
      );
      return;
    }
    response.end(
      JSON.stringify({
        id: "chatcmpl-provider-env",
        object: "chat.completion",
        created: 0,
        model: "mock-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "isolated" },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    );
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(8317, "127.0.0.1", resolveListen);
  });
  writeFileSync(
    join(home, ".config", "routekit", "router.yaml"),
    ["providers:", "  cliproxy: {}", "defaultModel: cliproxy/mock-model", ""].join("\n")
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    ROUTEKIT_CLIPROXY_API_KEY: "daemon-provider-key",
    PORTLESS: "0",
    ROUTEKIT_PORTLESS: "0",
    PATH: `${bin}${process.env.PATH !== undefined ? `:${process.env.PATH}` : ""}`,
    NO_COLOR: "1"
  };
  delete env.ROUTEKIT_CLIPROXY_BASE_URL;
  delete env.ROUTEKIT_NO_SUPERVISOR;
  const cli = { cwd: project, env };
  const tokenPath = join(stateHome, "secrets", "data-token");
  let daemonPid: number | undefined;

  const assertGateway = async (url: string): Promise<void> => {
    const token = readFileSync(tokenPath, "utf8").trim();
    const models = await authenticatedRequest(url, token, "/v1/models");
    assert.equal(models.status, 200);
    assert.deepEqual(
      ((await models.json()) as { data: Array<{ id: string }> }).data.map((entry) => entry.id),
      ["cliproxy/mock-model"]
    );
    const inference = await authenticatedRequest(url, token, "/v1/chat/completions", {
      model: "cliproxy/mock-model",
      messages: [{ role: "user", content: "prove isolation" }]
    });
    assert.equal(inference.status, 200);
    assert.match(await inference.text(), /isolated/);
  };

  try {
    const started = json(
      await runCli(["start", "--port", String(gatewayPort), "--no-portless", "--json"], cli)
    );
    assert.equal(started.supervisor, expectedSupervisor);
    daemonPid = started.pid as number;
    assert.ok(alive(daemonPid));
    await assertGateway(started.url as string);

    const restarted = json(await runCli(["daemon", "restart", "--json"], cli));
    assert.notEqual(restarted.pid, daemonPid);
    daemonPid = restarted.pid as number;
    await assertGateway(restarted.url as string);

    const reinstalled = json(
      await runCli(
        ["daemon", "service", "install", "--port", String(gatewayPort), "--no-portless", "--json"],
        cli
      )
    );
    assert.equal(reinstalled.supervisor, expectedSupervisor);
    assert.notEqual(reinstalled.pid, daemonPid);
    daemonPid = reinstalled.pid as number;
    await assertGateway(reinstalled.url as string);

    assert.equal(env.ROUTEKIT_CLIPROXY_BASE_URL, undefined);
    const stopped = json(await runCli(["stop", "--force", "--json"], cli));
    assert.equal(stopped.stopped, true);
    daemonPid = undefined;
  } finally {
    if (daemonPid !== undefined && alive(daemonPid)) {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervised daemon upgrade rolls to the installed CLI version", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-supervised-upgrade-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const stateHome = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(join(home, ".config", "routekit"), { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const expectedSupervisor = writeFakeSupervisor(bin, home);

  const upstream = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] })
      );
      return;
    }
    response.end(
      JSON.stringify({
        id: "chatcmpl-supervised",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" } }]
      })
    );
  });
  await new Promise<void>((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  writeFileSync(
    join(home, ".config", "routekit", "router.yaml"),
    ["providers:", "  openai: {}", "defaultModel: openai/mock-model", ""].join("\n")
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    OPENAI_API_KEY: "mock-secret",
    OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    PORTLESS: "0",
    ROUTEKIT_PORTLESS: "0",
    PATH: `${bin}${process.env.PATH !== undefined ? `:${process.env.PATH}` : ""}`,
    NO_COLOR: "1"
  };
  delete env.ROUTEKIT_NO_SUPERVISOR;
  const cli = { cwd: project, env };
  const recordPath = join(stateHome, "services", "daemon.json");
  let daemonPid: number | undefined;

  try {
    const started = json(
      await runCli(["start", "--port", "0", "--no-portless", "--drain-grace", "5", "--json"], cli)
    );
    assert.equal(started.alreadyRunning, false);
    assert.equal(started.supervisor, expectedSupervisor);
    daemonPid = started.pid as number;
    assert.ok(alive(daemonPid));
    assert.equal((await fetch(`${started.url as string}/health`)).status, 200);

    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      version: string;
      pid: number;
      workerPid?: number;
      binPath?: string;
      supervisor?: string;
    };
    assert.equal(record.supervisor, expectedSupervisor);
    assert.equal(record.binPath, CLI_ENTRY);
    const cliVersion = record.version;
    assert.notEqual(cliVersion, "0.0.0-old");
    writeFileSync(recordPath, `${JSON.stringify({ ...record, version: "0.0.0-old" }, null, 2)}\n`);

    const upgraded = json(await runCli(["daemon", "upgrade", "--json"], cli));
    assert.equal(upgraded.action, "rolling-upgrade");
    assert.equal(upgraded.hostPid, record.pid);
    assert.notEqual(upgraded.workerPid, record.workerPid);
    assert.equal(upgraded.previousPid, daemonPid);
    assert.notEqual(upgraded.pid, daemonPid);
    assert.equal(upgraded.from, "0.0.0-old");
    assert.equal(upgraded.to, cliVersion);
    await within(
      (async () => {
        while (daemonPid !== undefined && alive(daemonPid)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      })(),
      6_000,
      "supervised retiring worker exit"
    );
    daemonPid = upgraded.pid as number;
    assert.ok(alive(daemonPid));
    assert.equal((await fetch(`${upgraded.url as string}/health`)).status, 200);

    const successor = JSON.parse(readFileSync(recordPath, "utf8")) as {
      version: string;
      pid: number;
      workerPid?: number;
      supervisor?: string;
    };
    assert.equal(successor.version, cliVersion);
    assert.equal(successor.pid, upgraded.hostPid);
    assert.equal(successor.workerPid, daemonPid);
    assert.equal(successor.supervisor, expectedSupervisor);

    const stopped = json(await runCli(["stop", "--force", "--json"], cli));
    assert.equal(stopped.stopped, true);
    daemonPid = undefined;
  } finally {
    if (daemonPid !== undefined && alive(daemonPid)) {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});
