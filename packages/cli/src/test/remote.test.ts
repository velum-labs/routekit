import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { encodeJoinCredential } from "@velum-labs/routekit-runtime";
import { resolveLauncherPreparation } from "../commands/launchers.js";
import { parseControlRelayEnvelope, relayLocalControl } from "../control-relay.js";
import {
  activeRemote,
  deleteRemoteToken,
  findRemote,
  normalizeRemoteUrl,
  putRemote,
  readRemoteRegistry,
  readRemoteToken,
  remotesPath,
  remoteTokenPath,
  removeRemote,
  useRemote,
  validateSshHost,
  writeRemoteToken
} from "../remotes.js";
import { runSshRelay } from "../ssh-control.js";
import { redactSensitiveText } from "../ssh-exec.js";
import {
  assertLocalTarget,
  resetTargetSelectionForTest,
  selectedRemoteMetadata,
  setTargetSelection
} from "../target.js";

const execFileAsync = promisify(execFile);

function withRouteKitHome<T>(home: string, run: () => T): T {
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = home;
  try {
    return run();
  } finally {
    resetTargetSelectionForTest();
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
  }
}

async function withRouteKitHomeAsync<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = home;
  try {
    return await run();
  } finally {
    resetTargetSelectionForTest();
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
  }
}

test("remote registry is private and active selection has explicit precedence", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remotes-"));
  withRouteKitHome(home, () => {
    putRemote({
      name: "mini",
      gatewayUrl: "https://gateway.example/",
      sshHost: "velum-mini",
      addedAt: "2026-07-26T00:00:00.000Z"
    });
    putRemote(
      {
        name: "backup",
        gatewayUrl: "https://backup.example",
        sshHost: "backup-host",
        addedAt: "2026-07-26T00:00:01.000Z"
      },
      false
    );

    assert.equal(statSync(remotesPath()).mode & 0o777, 0o600);
    assert.equal(readFileSync(remotesPath(), "utf8").includes("token"), false);
    assert.equal(activeRemote()?.name, "mini");
    assert.equal(selectedRemoteMetadata()?.name, "mini");
    assert.throws(() => assertLocalTarget("start"), /manages the local daemon/);

    setTargetSelection({ local: false, remote: "backup" });
    assert.equal(selectedRemoteMetadata()?.name, "backup");
    setTargetSelection({ local: true });
    assert.equal(selectedRemoteMetadata(), undefined);
    assert.doesNotThrow(() => assertLocalTarget("start"));
    setTargetSelection({ local: true, remote: "mini" });
    assert.equal(selectedRemoteMetadata(), undefined);

    useRemote(undefined);
    assert.equal(readRemoteRegistry().active, undefined);
  });
});

test("file credential fallback uses mode 0600 and removal deletes credentials", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remote-token-"));
  await withRouteKitHomeAsync(home, async () => {
    await writeRemoteToken("mini", "private-token", { platform: "linux" });
    assert.equal(statSync(remoteTokenPath("mini")).mode & 0o777, 0o600);
    assert.equal(await readRemoteToken("mini", { platform: "linux" }), "private-token");
    await deleteRemoteToken("mini", { platform: "linux" });
    assert.equal(await readRemoteToken("mini", { platform: "linux" }), undefined);
  });
});

test("macOS credential storage uses a generic-password keychain entry", async () => {
  const calls: string[][] = [];
  const runKeychain = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    return args[0] === "find-generic-password" ? "from-keychain" : "";
  };
  await writeRemoteToken("mini", "private-token", { platform: "darwin", runKeychain });
  assert.equal(await readRemoteToken("mini", { platform: "darwin", runKeychain }), "from-keychain");
  await deleteRemoteToken("mini", { platform: "darwin", runKeychain });
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["add-generic-password", "find-generic-password", "delete-generic-password"]
  );
  assert.ok(calls.every((args) => args.includes("routekit-remote")));
  await assert.rejects(
    writeRemoteToken("mini", "must-not-leak", {
      platform: "darwin",
      runKeychain: async () => {
        throw new Error("security failed for must-not-leak");
      }
    }),
    (error: unknown) => {
      assert.doesNotMatch(String(error), /must-not-leak/);
      return true;
    }
  );
});

test("remote removal clears the active selection and file credential", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remote-remove-"));
  await withRouteKitHomeAsync(home, async () => {
    putRemote({
      name: "mini",
      gatewayUrl: "https://gateway.example",
      sshHost: "velum-mini",
      addedAt: "2026-07-26T00:00:00.000Z"
    });
    await writeRemoteToken("mini", "private-token", { platform: "linux" });
    const removed = await removeRemote("mini", { platform: "linux" });
    assert.equal(removed, true);
    assert.equal(activeRemote(), undefined);
    assert.deepEqual(readRemoteRegistry().remotes, []);
    assert.equal(existsSync(remoteTokenPath("mini")), false);
  });
});

test("remote URLs require authenticated HTTPS and reject URL metadata", () => {
  assert.equal(normalizeRemoteUrl("https://gateway.example/"), "https://gateway.example");
  assert.equal(normalizeRemoteUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(normalizeRemoteUrl("http://[::1]:8080/"), "http://[::1]:8080");
  assert.throws(() => normalizeRemoteUrl("http://gateway.example"), /require HTTPS/);
  assert.throws(() => normalizeRemoteUrl("ftp://localhost/gateway"), /require HTTPS/);
  assert.throws(() => normalizeRemoteUrl("https://gateway.example/?token=nope"), /query string/);
  assert.throws(() => normalizeRemoteUrl("https://user:pass@gateway.example"), /credentials/);
  assert.doesNotThrow(() => validateSshHost("alen@velum-mini"));
  assert.throws(() => validateSshHost("-oProxyCommand=bad"), /SSH host/);
  assert.throws(() => validateSshHost("velum mini"), /SSH host/);
});

test("SSH relay uses argv execution, exchanges JSON, and redacts request secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-ssh-relay-"));
  const ssh = join(directory, "ssh");
  const argsPath = join(directory, "args.txt");
  const inputPath = join(directory, "input.json");
  writeFileSync(
    ssh,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$@" > "$ROUTEKIT_TEST_ARGS"',
      "IFS= read -r payload",
      'printf \'%s\' "$payload" > "$ROUTEKIT_TEST_INPUT"',
      'printf \'%s\\n\' \'{"status":200,"body":{"protocol":"control.v1","id":"request-1","ok":true,"result":{"ready":true}}}\''
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(ssh, 0o700);
  const previousPath = process.env.PATH;
  const previousArgs = process.env.ROUTEKIT_TEST_ARGS;
  const previousInput = process.env.ROUTEKIT_TEST_INPUT;
  process.env.PATH = directory;
  process.env.ROUTEKIT_TEST_ARGS = argsPath;
  process.env.ROUTEKIT_TEST_INPUT = inputPath;
  try {
    const request = {
      protocol: "control.v1",
      id: "request-1",
      method: "accounts.enroll",
      params: { credential: "credential-secret" }
    };
    const result = await runSshRelay({ sshHost: "velum-mini" }, request);
    assert.equal(result.status, 200);
    // One argv entry per line. The host is terminated by `--`, and the relay
    // runs under the PATH preamble so a RouteKit installed outside the system
    // prefix (a user-owned npm prefix, Homebrew, nvm) is still reachable.
    const args = readFileSync(argsPath, "utf8").split("\n");
    assert.deepEqual(args.slice(0, 6), [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "--",
      "velum-mini"
    ]);
    assert.deepEqual([args[6], args[7]], ["sh", "-c"]);
    assert.match(args.slice(8).join("\n"), /^'set -u\nPATH="\$HOME\/\.local\/bin:/);
    assert.match(
      args.slice(8).join("\n"),
      /export PATH\nexec routekit --local --quiet daemon exec'\nroutekit-remote/
    );
    // The request body still travels on stdin, not the command line.
    assert.deepEqual(JSON.parse(readFileSync(inputPath, "utf8")), request);
    assert.equal(
      redactSensitiveText('failed {"credential":"credential-secret"}', ["credential-secret"]),
      'failed {"credential":"[redacted]"}'
    );
    assert.equal(
      redactSensitiveText('issued {"joinCredential":"rk1_secret-blob"}'),
      'issued {"joinCredential":"[redacted]"}'
    );
    assert.equal(
      redactSensitiveText("paste routekit peer add rk1_ABCDEFGHijklmnop"),
      "paste routekit peer add [redacted]"
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousArgs === undefined) delete process.env.ROUTEKIT_TEST_ARGS;
    else process.env.ROUTEKIT_TEST_ARGS = previousArgs;
    if (previousInput === undefined) delete process.env.ROUTEKIT_TEST_INPUT;
    else process.env.ROUTEKIT_TEST_INPUT = previousInput;
  }
});

test("SSH relay reports missing executables without exposing secrets", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "routekit-empty-path-"));
  try {
    await assert.rejects(
      runSshRelay(
        { sshHost: "velum-mini" },
        { method: "accounts.enroll", params: { credential: "credential-secret" } }
      ),
      (error: unknown) => {
        assert.match(String(error), /ssh was not found on PATH/);
        assert.doesNotMatch(String(error), /credential-secret/);
        return true;
      }
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("active remote launcher preparation injects gateway credentials without a local client", async () => {
  let localClientCalls = 0;
  const prepared = await resolveLauncherPreparation(
    { tool: "codex", model: "codex/gpt-5.5", cwd: "/workspace" },
    {
      resolve: async () => ({
        kind: "remote",
        remote: {
          name: "mini",
          gatewayUrl: "https://gateway.example",
          sshHost: "velum-mini",
          addedAt: "2026-07-26T00:00:00.000Z"
        },
        authToken: "private-token"
      }),
      client: async () => {
        localClientCalls += 1;
        throw new Error("local daemon must not start");
      }
    }
  );
  assert.equal(localClientCalls, 0);
  assert.equal(prepared.gatewayUrl, "https://gateway.example");
  assert.equal(prepared.authToken, "private-token");
  assert.equal(prepared.model, "codex/gpt-5.5");
});

test("active remote status uses SSH control and never creates a local daemon", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remote-status-"));
  const bin = mkdtempSync(join(tmpdir(), "routekit-remote-bin-"));
  withRouteKitHome(home, () => {
    putRemote({
      name: "mini",
      gatewayUrl: "https://gateway.example",
      sshHost: "velum-mini",
      addedAt: "2026-07-26T00:00:00.000Z"
    });
    mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(remoteTokenPath("mini"), "private-token\n", { mode: 0o600 });
  });
  const security = join(bin, "security");
  writeFileSync(security, "#!/bin/sh\nprintf '%s\\n' 'private-token'\n", { mode: 0o700 });
  chmodSync(security, 0o700);
  const ssh = join(bin, "ssh");
  writeFileSync(
    ssh,
    [
      `#!${process.execPath}`,
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const envelope = JSON.parse(input);",
      "  const request = envelope.request;",
      "  const results = {",
      "    'daemon.status': { pid: 42, startedAt: new Date(0).toISOString(), packageVersion: '0.9.10', protocolVersion: 'control.v1', generation: 1, configRevision: 1, accountRevision: 1, controlUrl: 'http://127.0.0.1:1', dataUrl: 'https://gateway.example', dataPort: 443, supervisor: 'systemd', draining: false },",
      "    'providers.status': { providers: [] },",
      "    'accounts.status': { accounts: [{ subscriptionKind: 'claude-code', label: 'work', connector: 'native', credentialValid: true, configured: true, relayOpen: true, serving: true, inFlight: 2, lastSelectedAt: 1700000000000, lastSelected: true, active: true, models: [] }], revision: 1, recovery: { state: 'clean', recovered: 0, cleaned: 0 } },",
      "    'models.list': { defaultModel: 'codex/gpt-5.5', models: [{ id: 'codex/gpt-5.5' }] }",
      "  };",
      "  const body = { protocol: request.protocol, id: request.id, ok: true, result: results[request.method] };",
      "  process.stdout.write(JSON.stringify({ status: 200, body }) + '\\n');",
      "});"
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(ssh, 0o700);
  const cli = fileURLToPath(new URL("../index.js", import.meta.url));
  const output = execFileSync(process.execPath, [cli, "--json", "status"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTEKIT_HOME: home,
      ROUTEKIT_NO_TUI: "1",
      PATH: `${bin}:${process.env.PATH ?? ""}`
    }
  });
  const status = JSON.parse(output) as {
    remote?: string;
    daemon?: { dataUrl?: string };
    accounts?: {
      accounts?: Array<{
        serving?: boolean;
        inFlight?: number;
        lastSelected?: boolean;
        lastSelectedAt?: number;
        active?: boolean;
      }>;
    };
  };
  assert.equal(status.remote, "mini");
  assert.equal(status.daemon?.dataUrl, "https://gateway.example");
  assert.equal(status.accounts?.accounts?.[0]?.serving, true);
  assert.equal(status.accounts?.accounts?.[0]?.inFlight, 2);
  assert.equal(status.accounts?.accounts?.[0]?.lastSelected, true);
  assert.equal(status.accounts?.accounts?.[0]?.lastSelectedAt, 1_700_000_000_000);
  assert.equal(status.accounts?.accounts?.[0]?.active, true);
  assert.equal(existsSync(join(home, "services", "daemon.json")), false);
});

test("active remote leaderboard reads authoritative remote daemon state", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remote-leaderboard-"));
  const bin = mkdtempSync(join(tmpdir(), "routekit-remote-lb-bin-"));
  withRouteKitHome(home, () => {
    putRemote({
      name: "mini",
      gatewayUrl: "https://gateway.example",
      sshHost: "velum-mini",
      addedAt: "2026-07-26T00:00:00.000Z"
    });
    mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(remoteTokenPath("mini"), "private-token\n", { mode: 0o600 });
  });
  const security = join(bin, "security");
  writeFileSync(security, "#!/bin/sh\nprintf '%s\\n' 'private-token'\n", { mode: 0o700 });
  chmodSync(security, 0o700);
  const ssh = join(bin, "ssh");
  writeFileSync(
    ssh,
    [
      `#!${process.execPath}`,
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const envelope = JSON.parse(input);",
      "  const request = envelope.request;",
      "  if (request.method !== 'calls.leaderboard') {",
      "    process.stdout.write(JSON.stringify({ status: 500, body: { error: 'unexpected ' + request.method } }) + '\\n');",
      "    return;",
      "  }",
      "  if (request.params.window !== undefined) {",
      "    process.stdout.write(JSON.stringify({ status: 500, body: { error: 'implicit window should be selected by the daemon' } }) + '\\n');",
      "    return;",
      "  }",
      "  const body = {",
      "    protocol: request.protocol,",
      "    id: request.id,",
      "    ok: true,",
      "    result: {",
      "      by: request.params.by,",
      "      sort: request.params.sort,",
      "      window: { start: '2026-07-27T00:00:00.000Z', end: '2026-07-27T01:00:00.000Z' },",
      "      source: 'durable',",
      "      sampleSize: 2,",
      "      truncated: false,",
      "      budget: { liveLimit: 1000, liveTtlHours: 24, durable: true, durableRetentionDays: 14 },",
      "      rows: [{ rank: 1, key: 'codex', requests: 2, tokensIn: 30, tokensOut: 10, tokensTotal: 40, estimateUsd: 1.5, unknownCostCount: 0, unknownUsageCount: 0, success: 2, error: 0, latencyMsAvg: 120 }]",
      "    }",
      "  };",
      "  process.stdout.write(JSON.stringify({ status: 200, body }) + '\\n');",
      "});"
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(ssh, 0o700);
  const cli = fileURLToPath(new URL("../index.js", import.meta.url));
  const output = execFileSync(
    process.execPath,
    [cli, "--json", "leaderboard", "--by", "provider", "--sort", "requests"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ROUTEKIT_HOME: home,
        ROUTEKIT_NO_TUI: "1",
        PATH: `${bin}:${process.env.PATH ?? ""}`
      }
    }
  );
  const board = JSON.parse(output) as {
    by?: string;
    rows?: Array<{ key?: string; requests?: number }>;
  };
  assert.equal(board.by, "provider");
  assert.equal(board.rows?.[0]?.key, "codex");
  assert.equal(board.rows?.[0]?.requests, 2);
  assert.equal(existsSync(join(home, "services", "daemon.json")), false);
});

test("control relay validates protocol envelopes and reports a stopped daemon", async () => {
  assert.deepEqual(parseControlRelayEnvelope({ kind: "health" }), { kind: "health" });
  assert.throws(
    () =>
      parseControlRelayEnvelope({
        kind: "call",
        request: { protocol: "control.v0", id: "request-1", method: "daemon.status" }
      }),
    /invalid control relay request/
  );
  const home = mkdtempSync(join(tmpdir(), "routekit-relay-empty-"));
  await withRouteKitHomeAsync(home, async () => {
    const result = await relayLocalControl({
      kind: "call",
      request: {
        protocol: "control.v1",
        id: "request-1",
        method: "daemon.status",
        params: {}
      }
    });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, {
      protocol: "control.v1",
      id: "request-1",
      ok: false,
      error: { code: "unavailable", message: "RouteKit daemon is not running" }
    });
  });
});

test("`remote add --join` enrolls the peer over SSH before the remote", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remote-join-"));
  const bin = mkdtempSync(join(tmpdir(), "routekit-remote-join-bin-"));
  const transcript = join(bin, "transcript.jsonl");
  const joinCredential = encodeJoinCredential({
    publicRecordPath: "/Users/alen/.routekit/services/daemon.public.json",
    token: "peer-control-secret"
  });

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
      "const script = argv[argv.indexOf('-c') + 1] || '';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      `  appendFileSync(${JSON.stringify(transcript)}, JSON.stringify({ argv, input, script }) + '\\n');`,
      "  if (script.includes('peer add')) {",
      "    if (!input.trim().startsWith('rk1_')) {",
      "      process.stderr.write('missing join credential on stdin\\n');",
      "      process.exit(1);",
      "    }",
      "    process.stdout.write(JSON.stringify({ peer: { publicRecordPath: '/Users/alen/.routekit/services/daemon.public.json' } }) + '\\n');",
      "    return;",
      "  }",
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
      "        protocolVersion: 'control.v1',",
      "        product: 'routekit',",
      "        packageVersion: '0.13.0',",
      "        capabilities: ['routekit.control.v1']",
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
      "    process.stdout.write(JSON.stringify({",
      "      status: 200,",
      "      body: { protocol: request.protocol, id: request.id, ok: true, result }",
      "    }) + '\\n');",
      "    return;",
      "  }",
      "  process.stderr.write('unexpected invocation\\n');",
      "  process.exit(1);",
      "});"
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(ssh, 0o700);

  const security = join(bin, "security");
  const keychainStore = join(home, "secrets", "remote-mini");
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
      'if [ "$cmd" = "add-generic-password" ]; then',
      '  mkdir -p "$(dirname "$store")"',
      '  printf "%s\\n" "$password" > "$store"',
      "  exit 0",
      "fi",
      'if [ "$cmd" = "find-generic-password" ]; then',
      '  cat "$store"',
      "  exit 0",
      "fi",
      'if [ "$cmd" = "delete-generic-password" ]; then',
      '  rm -f "$store"',
      "  exit 0",
      "fi",
      "exit 1"
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(security, 0o700);

  const cli = fileURLToPath(new URL("../index.js", import.meta.url));
  try {
    const { stdout: output } = await execFileAsync(
      process.execPath,
      [
        cli,
        "--json",
        "remote",
        "add",
        "mini",
        "--url",
        `http://127.0.0.1:${port}`,
        "--ssh",
        "benjamin@velum-mini",
        "--join",
        joinCredential
      ],
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
      remote?: { name: string; gatewayUrl: string; sshHost: string; active: boolean };
      peer?: { publicRecordPath: string };
    };
    assert.equal(result.remote?.name, "mini");
    assert.equal(result.remote?.gatewayUrl, `http://127.0.0.1:${port}`);
    assert.equal(result.remote?.sshHost, "benjamin@velum-mini");
    assert.equal(result.remote?.active, true);
    assert.equal(
      result.peer?.publicRecordPath,
      "/Users/alen/.routekit/services/daemon.public.json"
    );

    const calls = readFileSync(transcript, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { argv: string[]; input: string; script: string });
    assert.ok(calls[0]?.script.includes("peer add"));
    assert.equal(calls[0]?.input.trim(), joinCredential);
    assert.doesNotMatch(calls[0]?.argv.join(" ") ?? "", /rk1_/);
    assert.ok(calls.slice(1).some((call) => call.script.includes("daemon exec")));
    assert.equal(
      readFileSync(join(home, "secrets", "remote-mini"), "utf8").trim(),
      "remote-data-token"
    );
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});

test("`remote add --join` aborts before writing the remote when peer enrollment fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remote-join-fail-"));
  const bin = mkdtempSync(join(tmpdir(), "routekit-remote-join-fail-bin-"));
  const joinCredential = encodeJoinCredential({
    publicRecordPath: "/Users/alen/.routekit/services/daemon.public.json",
    token: "peer-control-secret"
  });

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
      "const argv = process.argv.slice(2);",
      "const script = argv[argv.indexOf('-c') + 1] || '';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  if (script.includes('peer add')) {",
      "    process.stdout.write(JSON.stringify({ error: { message: 'public daemon record not found' } }) + '\\n');",
      "    process.exit(1);",
      "  }",
      "  process.stderr.write('unexpected invocation after peer failure\\n');",
      "  process.exit(1);",
      "});"
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(ssh, 0o700);

  const cli = fileURLToPath(new URL("../index.js", import.meta.url));
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          cli,
          "--json",
          "remote",
          "add",
          "mini",
          "--url",
          `http://127.0.0.1:${port}`,
          "--ssh",
          "benjamin@velum-mini",
          "--join",
          joinCredential
        ],
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
        const failure = error as { code?: number; stderr?: string; stdout?: string };
        assert.notEqual(failure.code, 0);
        const text = `${failure.stderr ?? ""}\n${failure.stdout ?? ""}`;
        assert.match(text, /peer enrollment over SSH/);
        assert.match(text, /public daemon record not found/);
        assert.doesNotMatch(text, /peer-control-secret/);
        assert.doesNotMatch(text, /rk1_/);
        return true;
      }
    );
    assert.equal(existsSync(join(home, "remotes.json")), false);
    assert.equal(existsSync(join(home, "secrets", "remote-mini")), false);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});
