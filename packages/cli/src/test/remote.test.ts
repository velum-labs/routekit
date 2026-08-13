import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
import { immutableCliRuntime, processCliRuntime } from "@velum-labs/routekit-cli-core";
import type { RouteKitControlClient } from "@velum-labs/routekit-control";
import { encodeJoinCredential } from "@velum-labs/routekit-runtime";
import { Effect } from "effect";
import { activeCliSession, CliSession, runWithCliSession } from "../cli-session.js";
import { resolveLauncherPreparation } from "../commands/launchers.js";
import { parseControlRelayEnvelope, relayLocalControl } from "../control-relay.js";
import { RemoteCredentialRepository } from "../remote-credential-repository.js";
import { RemoteRegistryRepository } from "../remote-registry-repository.js";
import { normalizeRemoteUrl, validateSshHost } from "../remotes.js";
import { runSshRelay } from "../ssh-control.js";
import { redactSensitiveText } from "../ssh-exec.js";
import { assertLocalTarget, selectedRemoteMetadata, setTargetSelection } from "../target.js";

const execFileAsync = promisify(execFile);
const remoteRegistry = new RemoteRegistryRepository();

const activeRemote = () => remoteRegistry.active();
const findRemote = (name: string) => remoteRegistry.find(name);
const putRemote = (...args: Parameters<RemoteRegistryRepository["put"]>) =>
  remoteRegistry.put(...args);
const readRemoteRegistry = () => remoteRegistry.read();
const remotesPath = () => remoteRegistry.path();
const useRemote = (name: string | undefined) => remoteRegistry.use(name);
const remoteTokenPath = (name: string) => new RemoteCredentialRepository().path(name);
const writeRemoteToken = (
  name: string,
  token: string,
  options?: ConstructorParameters<typeof RemoteCredentialRepository>[0]
) => new RemoteCredentialRepository(options).write(name, token);
const readRemoteToken = (
  name: string,
  options?: ConstructorParameters<typeof RemoteCredentialRepository>[0]
) => new RemoteCredentialRepository(options).read(name);
const deleteRemoteToken = (
  name: string,
  options?: ConstructorParameters<typeof RemoteCredentialRepository>[0]
) => new RemoteCredentialRepository(options).delete(name);

function invocationSession(): CliSession {
  return new CliSession(immutableCliRuntime(processCliRuntime));
}

function withRouteKitHome<T>(home: string, run: () => T): T {
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = home;
  try {
    return runWithCliSession(invocationSession(), run);
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
  }
}

async function withRouteKitHomeAsync<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = home;
  try {
    return await runWithCliSession(invocationSession(), run);
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
  }
}

async function startRemoteTransactionFixture(input: {
  root: string;
  failRevoke?: boolean;
}): Promise<{
  gatewayUrl: string;
  sshBin: string;
  transcript: string;
  close(): Promise<void>;
}> {
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
  const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const sshBin = join(input.root, "bin");
  const transcript = join(input.root, "control-methods.jsonl");
  mkdirSync(sshBin, { recursive: true });
  const ssh = join(sshBin, "ssh");
  writeFileSync(
    ssh,
    [
      `#!${process.execPath}`,
      "const { appendFileSync } = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const envelope = JSON.parse(input);",
      "  if (envelope.kind === 'health') {",
      "    process.stdout.write(JSON.stringify({ status: 200, body: { status: 'ok' } }) + '\\n');",
      "    return;",
      "  }",
      "  const request = envelope.request;",
      `  appendFileSync(${JSON.stringify(transcript)}, JSON.stringify({ method: request.method, params: request.params }) + '\\n');`,
      "  let result;",
      "  if (request.method === 'hello') {",
      "    result = {",
      "      protocolVersion: 'control.v2',",
      "      product: 'routekit',",
      "      packageVersion: '0.18.2',",
      "      capabilities: ['routekit.control.v2']",
      "    };",
      "  } else if (request.method === 'tokens.issue') {",
      "    result = {",
      "      id: 'new-token-id',",
      "      label: request.params.label,",
      "      plane: 'data',",
      "      role: 'admin',",
      "      createdAt: '2026-08-11T00:00:00.000Z',",
      "      token: 'new-private-token'",
      "    };",
      "  } else if (request.method === 'tokens.revoke') {",
      ...(input.failRevoke
        ? [
            "    process.stdout.write(JSON.stringify({",
            "      status: 503,",
            "      body: {",
            "        protocol: request.protocol,",
            "        id: request.id,",
            "        ok: false,",
            "        error: { code: 'unavailable', message: 'injected revoke failure' }",
            "      }",
            "    }) + '\\n');",
            "    return;"
          ]
        : [
            "    result = {",
            "      id: request.params.id,",
            "      label: 'remote-mini@test',",
            "      plane: 'data',",
            "      role: 'admin',",
            "      createdAt: '2026-08-11T00:00:00.000Z',",
            "      revokedAt: '2026-08-11T00:01:00.000Z'",
            "    };"
          ]),
      "  } else {",
      "    process.stderr.write('unexpected method ' + request.method + '\\n');",
      "    process.exit(1);",
      "  }",
      "  process.stdout.write(JSON.stringify({",
      "    status: 200,",
      "    body: { protocol: request.protocol, id: request.id, ok: true, result }",
      "  }) + '\\n');",
      "});"
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(ssh, 0o700);
  return {
    gatewayUrl,
    sshBin,
    transcript,
    close: async () => {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  };
}

function remoteTransactionMethods(path: string): Array<{
  method: string;
  params: Record<string, unknown>;
}> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

async function runRemoteCli(
  args: readonly string[],
  input: { home: string; sshBin: string }
): Promise<{ stdout: string; stderr: string }> {
  const cli = fileURLToPath(new URL("../index.js", import.meta.url));
  return await execFileAsync(process.execPath, [cli, "--json", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: input.home,
      ROUTEKIT_HOME: input.home,
      ROUTEKIT_NO_TUI: "1",
      PATH: `${input.sshBin}:${process.env.PATH ?? ""}`
    }
  });
}

test("remote registry is private and active selection has explicit precedence", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remotes-"));
  withRouteKitHome(home, () => {
    putRemote({
      name: "mini",
      gatewayUrl: "https://gateway.example/",
      sshHost: "velum-mini",
      addedAt: "2026-07-26T00:00:00.000Z",
      tokenId: "token-mini"
    });
    putRemote(
      {
        name: "backup",
        gatewayUrl: "https://backup.example",
        sshHost: "backup-host",
        addedAt: "2026-07-26T00:00:01.000Z",
        tokenId: "token-backup"
      },
      false
    );

    assert.equal(statSync(remotesPath()).mode & 0o777, 0o600);
    assert.equal(readFileSync(remotesPath(), "utf8").includes("private-token"), false);
    assert.equal(activeRemote()?.name, "mini");
    assert.equal(selectedRemoteMetadata()?.name, "mini");
    assert.throws(() => assertLocalTarget("start"), /manages the local daemon/);

    setTargetSelection({ local: false, remote: "backup" }, activeCliSession());
    assert.equal(selectedRemoteMetadata()?.name, "backup");
    setTargetSelection({ local: true }, activeCliSession());
    assert.equal(selectedRemoteMetadata(), undefined);
    assert.doesNotThrow(() => assertLocalTarget("start"));
    setTargetSelection({ local: true, remote: "mini" }, activeCliSession());
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

test("remote repositories remove active selection and file credential", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remote-remove-"));
  await withRouteKitHomeAsync(home, async () => {
    putRemote({
      name: "mini",
      gatewayUrl: "https://gateway.example",
      sshHost: "velum-mini",
      addedAt: "2026-07-26T00:00:00.000Z",
      tokenId: "token-mini"
    });
    await writeRemoteToken("mini", "private-token", { platform: "linux" });
    remoteRegistry.write({ version: 1, remotes: [] });
    await deleteRemoteToken("mini", { platform: "linux" });
    assert.equal(activeRemote(), undefined);
    assert.deepEqual(readRemoteRegistry().remotes, []);
    assert.equal(existsSync(remoteTokenPath("mini")), false);
  });
});

test("remote enrollment revokes an issued token when credential storage fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-remote-credential-failure-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "secrets"), "injected credential-store obstruction");
  const fixture = await startRemoteTransactionFixture({ root });
  try {
    await assert.rejects(
      runRemoteCli(["remote", "add", "mini", "--url", fixture.gatewayUrl, "--ssh", "test-host"], {
        home,
        sshBin: fixture.sshBin
      })
    );
    assert.deepEqual(
      remoteTransactionMethods(fixture.transcript).map((entry) => entry.method),
      ["hello", "tokens.issue", "tokens.revoke"]
    );
    assert.deepEqual(remoteTransactionMethods(fixture.transcript).at(-1)?.params, {
      id: "new-token-id"
    });
    assert.equal(existsSync(join(home, "remotes.json")), false);
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote enrollment records unresolved compensation when token revocation fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-remote-compensation-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "secrets"), "injected credential-store obstruction");
  const fixture = await startRemoteTransactionFixture({ root, failRevoke: true });
  try {
    await assert.rejects(
      runRemoteCli(["remote", "add", "mini", "--url", fixture.gatewayUrl, "--ssh", "test-host"], {
        home,
        sshBin: fixture.sshBin
      }),
      (error: unknown) => {
        const failure = error as { stderr?: string; stdout?: string };
        assert.match(`${failure.stderr ?? ""}\n${failure.stdout ?? ""}`, /could not be revoked/);
        return true;
      }
    );
    assert.deepEqual(
      remoteTransactionMethods(fixture.transcript).map((entry) => entry.method),
      ["hello", "tokens.issue", "tokens.revoke"]
    );
    const compensation = JSON.parse(
      readFileSync(join(home, "remote-compensations.v1.json"), "utf8")
    ) as {
      version: number;
      entries: Array<{
        remote: string;
        tokenId: string;
        action: string;
        reason: string;
      }>;
    };
    assert.equal(compensation.version, 1);
    assert.deepEqual(
      compensation.entries.map(({ remote, tokenId, action }) => ({
        remote,
        tokenId,
        action
      })),
      [{ remote: "mini", tokenId: "new-token-id", action: "revoke" }]
    );
    assert.match(compensation.entries[0]?.reason ?? "", /injected revoke failure/);
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote registry commit failure restores the previous credential and registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-remote-registry-failure-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  await withRouteKitHomeAsync(home, async () => {
    putRemote({
      name: "mini",
      gatewayUrl: "https://previous.example",
      sshHost: "previous-host",
      addedAt: "2026-08-10T00:00:00.000Z",
      tokenId: "previous-token-id"
    });
    await writeRemoteToken("mini", "previous-private-token", { platform: "linux" });
  });
  const previousRegistry = readFileSync(join(home, "remotes.json"), "utf8");
  const fixture = await startRemoteTransactionFixture({ root });
  chmodSync(home, 0o500);
  try {
    await assert.rejects(
      runRemoteCli(
        ["remote", "add", "mini", "--url", fixture.gatewayUrl, "--ssh", "replacement-host"],
        { home, sshBin: fixture.sshBin }
      )
    );
    assert.deepEqual(
      remoteTransactionMethods(fixture.transcript).map((entry) => entry.method),
      ["hello", "tokens.issue", "tokens.revoke"]
    );
    assert.equal(readFileSync(join(home, "remotes.json"), "utf8"), previousRegistry);
    assert.equal(
      readFileSync(join(home, "secrets", "remote-mini"), "utf8"),
      "previous-private-token\n"
    );
  } finally {
    chmodSync(home, 0o700);
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote removal revoke failure leaves registry and credential untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-remote-remove-revoke-failure-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  await withRouteKitHomeAsync(home, async () => {
    putRemote({
      name: "mini",
      gatewayUrl: "https://gateway.example",
      sshHost: "test-host",
      addedAt: "2026-08-11T00:00:00.000Z",
      tokenId: "existing-token-id"
    });
    await writeRemoteToken("mini", "existing-private-token", { platform: "linux" });
  });
  const previousRegistry = readFileSync(join(home, "remotes.json"), "utf8");
  const fixture = await startRemoteTransactionFixture({ root, failRevoke: true });
  try {
    await assert.rejects(
      runRemoteCli(["remote", "remove", "mini"], {
        home,
        sshBin: fixture.sshBin
      })
    );
    assert.deepEqual(remoteTransactionMethods(fixture.transcript), [
      { method: "tokens.revoke", params: { id: "existing-token-id" } }
    ]);
    assert.equal(readFileSync(join(home, "remotes.json"), "utf8"), previousRegistry);
    assert.equal(
      readFileSync(join(home, "secrets", "remote-mini"), "utf8"),
      "existing-private-token\n"
    );
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
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
      'printf \'%s\\n\' \'{"status":200,"body":{"protocol":"control.v2","id":"request-1","ok":true,"result":{"ready":true}}}\''
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
      protocol: "control.v2",
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
          addedAt: "2026-07-26T00:00:00.000Z",
          tokenId: "token-mini"
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

test("local launcher preparation rejects a daemon response for a different tool", async () => {
  const client = {
    call: () =>
      Effect.succeed({
        tool: "cursor",
        model: "codex/gpt-5.5",
        gatewayUrl: "http://127.0.0.1:8080",
        env: {}
      })
  } as unknown as RouteKitControlClient;
  await assert.rejects(
    resolveLauncherPreparation(
      { tool: "codex", model: "codex/gpt-5.5", cwd: "/workspace" },
      {
        resolve: async () => ({ kind: "local" }),
        client: async () => client
      }
    ),
    /returned cursor for requested tool codex/
  );
});

test("active remote status uses SSH control and never creates a local daemon", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remote-status-"));
  const bin = mkdtempSync(join(tmpdir(), "routekit-remote-bin-"));
  withRouteKitHome(home, () => {
    putRemote({
      name: "mini",
      gatewayUrl: "https://gateway.example",
      sshHost: "velum-mini",
      addedAt: "2026-07-26T00:00:00.000Z",
      tokenId: "token-mini"
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
      "    'daemon.status': { pid: 42, startedAt: new Date(0).toISOString(), packageVersion: '0.9.10', protocolVersion: 'control.v2', generation: 1, configRevision: 1, accountRevision: 1, controlUrl: 'http://127.0.0.1:1', dataUrl: 'https://gateway.example', dataPort: 443, supervisor: 'systemd', draining: false },",
      "    'providers.status': { providers: [] },",
      "    'accounts.status': { accounts: [{ subscriptionKind: 'claude-code', label: 'work', connector: 'native', credentialValid: true, configured: true, relayOpen: true, serving: true, inFlight: 2, lastSelectedAt: 1700000000000, lastSelected: true, models: [] }], revision: 1, recovery: { state: 'clean', recovered: 0, cleaned: 0 } },",
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
      }>;
    };
  };
  assert.equal(status.remote, "mini");
  assert.equal(status.daemon?.dataUrl, "https://gateway.example");
  assert.equal(status.accounts?.accounts?.[0]?.serving, true);
  assert.equal(status.accounts?.accounts?.[0]?.inFlight, 2);
  assert.equal(status.accounts?.accounts?.[0]?.lastSelected, true);
  assert.equal(status.accounts?.accounts?.[0]?.lastSelectedAt, 1_700_000_000_000);
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
      addedAt: "2026-07-26T00:00:00.000Z",
      tokenId: "token-mini"
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
        protocol: "control.v2",
        id: "request-1",
        method: "daemon.status",
        params: {}
      }
    });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, {
      protocol: "control.v2",
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
      "        protocolVersion: 'control.v2',",
      "        product: 'routekit',",
      "        packageVersion: '0.13.0',",
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

test("token commands target the selected remote control relay", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-remote-tokens-"));
  const home = join(root, "home");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const transcript = join(root, "relay.jsonl");
  const cli = fileURLToPath(new URL("../index.js", import.meta.url));
  try {
    mkdirSync(join(state, "secrets"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(state, "remotes.json"),
      `${JSON.stringify(
        {
          version: 1,
          active: "mini",
          remotes: [
            {
              name: "mini",
              gatewayUrl: "https://gateway.example",
              sshHost: "velum-mini",
              addedAt: "2026-08-01T00:00:00.000Z",
              tokenId: "0011223344556677"
            }
          ]
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    writeFileSync(join(state, "secrets", "remote-mini"), "remote-gateway-token\n", {
      mode: 0o600
    });
    writeFileSync(
      join(bin, "ssh"),
      [
        `#!${process.execPath}`,
        "const { appendFileSync } = require('node:fs');",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        `  appendFileSync(${JSON.stringify(transcript)}, input);`,
        "  const envelope = JSON.parse(input);",
        "  const request = envelope.request;",
        "  let result;",
        "  if (request.method === 'tokens.issue') {",
        "    result = { id: '0011223344556677', label: request.params.label, plane: 'data', role: 'admin', token: 'remote-data-token' };",
        "  } else if (request.method === 'tokens.list') {",
        "    result = { tokens: [{ id: '0011223344556677', label: 't3-routekit-default-0123456789abcdef01234567-codex', plane: 'data', role: 'admin', createdAt: '2026-08-01T00:00:00.000Z', createdBy: 't3-routekit:default:0123456789abcdef01234567:codex' }] };",
        "  } else if (request.method === 'tokens.revoke') {",
        "    result = { id: request.params.id, label: 't3-routekit-default-0123456789abcdef01234567-codex', plane: 'data', role: 'admin', createdAt: '2026-08-01T00:00:00.000Z', revokedAt: '2026-08-01T00:01:00.000Z' };",
        "  } else { process.stderr.write('unexpected method ' + request.method); process.exit(1); return; }",
        "  process.stdout.write(JSON.stringify({ status: 200, body: { protocol: request.protocol, id: request.id, ok: true, result } }) + '\\n');",
        "});"
      ].join("\n"),
      { mode: 0o700 }
    );
    chmodSync(join(bin, "ssh"), 0o700);
    writeFileSync(
      join(bin, "security"),
      '#!/bin/sh\nif [ "$1" = "find-generic-password" ]; then printf "%s\\n" "remote-gateway-token"; exit 0; fi\nexit 1\n',
      { mode: 0o700 }
    );
    chmodSync(join(bin, "security"), 0o700);
    const env = {
      ...process.env,
      HOME: home,
      ROUTEKIT_HOME: state,
      ROUTEKIT_TELEMETRY: "0",
      PATH: `${bin}:${process.env.PATH ?? ""}`
    };
    const issue = await execFileAsync(
      process.execPath,
      [
        cli,
        "--remote",
        "mini",
        "--json",
        "token",
        "issue",
        "t3-routekit-default-0123456789abcdef01234567-codex",
        "--plane",
        "data",
        "--created-by",
        "t3-routekit:default:0123456789abcdef01234567:codex"
      ],
      { encoding: "utf8", env }
    );
    assert.equal(JSON.parse(issue.stdout).id, "0011223344556677");
    const listed = await execFileAsync(
      process.execPath,
      [cli, "--remote", "mini", "--json", "token", "list"],
      { encoding: "utf8", env }
    );
    assert.equal(JSON.parse(listed.stdout).tokens.length, 1);
    const revoked = await execFileAsync(
      process.execPath,
      [cli, "--remote", "mini", "--json", "token", "revoke", "0011223344556677"],
      { encoding: "utf8", env }
    );
    assert.equal(JSON.parse(revoked.stdout).id, "0011223344556677");
    const requests = readFileSync(transcript, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { request: { method: string } });
    assert.deepEqual(
      requests.map((entry) => entry.request.method),
      ["tokens.issue", "tokens.list", "tokens.revoke"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
