import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeJoinCredential } from "@velum-labs/routekit-runtime";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

function run(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env, timeout: 90_000 },
      (error, stdout, stderr) => {
        resolveRun({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr
        });
      }
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

test("a peer account administers the owner's daemon through the peer pointer", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-peer-"));
  const ownerHome = join(root, "owner-home");
  const ownerState = join(ownerHome, ".routekit");
  const peerHome = join(root, "peer-home");
  const peerState = join(peerHome, ".routekit");
  const project = join(root, "project");
  mkdirSync(join(ownerHome, ".config", "routekit"), { recursive: true });
  mkdirSync(peerHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(ownerHome, ".config", "routekit", "router.yaml"),
    "providers:\n  openai: {}\ndefaultModel: openai/mock-model\n"
  );
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    req.resume();
    req.on("end", () =>
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      )
    );
  });
  await new Promise<void>((resolveListen) =>
    upstream.listen(0, "127.0.0.1", resolveListen)
  );
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const shared = {
    ...process.env,
    ROUTEKIT_PORTLESS: "0",
    ROUTEKIT_NO_SUPERVISOR: "1",
    ROUTEKIT_DAEMON_PORT: "0",
    OPENAI_API_KEY: "test",
    OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    NO_COLOR: "1"
  };
  const ownerEnv = { ...shared, HOME: ownerHome, ROUTEKIT_HOME: ownerState };
  const peerEnv = { ...shared, HOME: peerHome, ROUTEKIT_HOME: peerState };
  let pid: number | undefined;
  try {
    const started = await run(["start", "--port", "0", "--json"], project, ownerEnv);
    assert.equal(started.code, 0, started.stderr);
    const record = JSON.parse(
      readFileSync(join(ownerState, "services", "daemon.json"), "utf8")
    ) as { pid: number; workerPid?: number; controlToken?: string };
    pid = record.pid;
    assert.equal(typeof record.workerPid, "number");
    const workerPid = record.workerPid;

    const publicRecordPath = join(ownerState, "services", "daemon.public.json");
    assert.ok(existsSync(publicRecordPath));
    const published = JSON.parse(readFileSync(publicRecordPath, "utf8")) as
      Record<string, unknown>;
    // Discovery is world-readable, so it must never carry a credential.
    assert.equal(published.controlToken, undefined);
    assert.doesNotMatch(
      readFileSync(publicRecordPath, "utf8"),
      new RegExp(record.controlToken!)
    );
    assert.equal(statSync(publicRecordPath).mode & 0o777, 0o644);
    // Peers traverse both directories to reach the record by exact path.
    assert.equal(statSync(ownerState).mode & 0o777, 0o711);
    assert.equal(statSync(join(ownerState, "services")).mode & 0o777, 0o711);
    assert.equal(
      statSync(join(ownerState, "services", "daemon.json")).mode & 0o777,
      0o600
    );
    assert.equal(statSync(join(ownerState, "secrets")).mode & 0o777, 0o700);

    const issued = await run(
      ["token", "issue", "peer-admin", "--plane", "control", "--json"],
      project,
      ownerEnv
    );
    assert.equal(issued.code, 0, issued.stderr);
    const controlToken = JSON.parse(issued.stdout) as {
      token: string;
      id: string;
      joinCredential?: string;
    };
    assert.ok(
      typeof controlToken.joinCredential === "string" &&
        controlToken.joinCredential.startsWith("rk1_"),
      "control token issue must return a self-describing join credential"
    );

    // Before enrollment the peer account has no daemon of its own.
    const beforeStatus = await run(["status", "--json"], project, peerEnv);
    assert.equal(beforeStatus.code, 0, beforeStatus.stderr);
    assert.equal(
      (JSON.parse(beforeStatus.stdout) as { daemon?: { running?: boolean } }).daemon
        ?.running,
      false
    );

    // A well-formed credential carrying a secret the daemon rejects must fail
    // at enrollment and leave no pointer behind.
    const stale = encodeJoinCredential({
      publicRecordPath,
      token: "stale-control-secret"
    });
    const staleAdd = await run(["peer", "add", stale], project, peerEnv);
    assert.equal(staleAdd.code, 1);
    assert.match(staleAdd.stderr, /rejected this account's control token/);
    assert.equal(existsSync(join(peerState, "peer.json")), false);

    const added = await run(
      ["peer", "add", "-", "--json"],
      project,
      peerEnv,
      `${controlToken.joinCredential}\n`
    );
    assert.equal(added.code, 0, added.stderr);
    assert.equal(
      (JSON.parse(added.stdout) as { peer?: { controlUrl?: string } }).peer
        ?.controlUrl,
      published.url
    );
    // The peer pointer stores the bare secret, never the join blob.
    const pointer = JSON.parse(
      readFileSync(join(peerState, "peer.json"), "utf8")
    ) as { controlToken: string; publicRecordPath: string };
    assert.equal(pointer.controlToken, controlToken.token);
    assert.doesNotMatch(pointer.controlToken, /^rk1_/);
    assert.equal(pointer.publicRecordPath, publicRecordPath);

    // `status` must relay through the pointer rather than report a dead daemon.
    const peerStatus = await run(["status", "--json"], project, peerEnv);
    assert.equal(peerStatus.code, 0, peerStatus.stderr);
    const overview = JSON.parse(peerStatus.stdout) as {
      daemon?: { pid?: number; hostPid?: number; running?: boolean };
      models?: { count?: number };
    };
    assert.equal(overview.daemon?.pid, workerPid);
    assert.equal(overview.daemon?.hostPid, pid);
    assert.equal(overview.models?.count, 1);
    const peerDaemonStatus = await run(["daemon", "status", "--json"], project, peerEnv);
    assert.equal(peerDaemonStatus.code, 0, peerDaemonStatus.stderr);
    const daemonStatus = JSON.parse(peerDaemonStatus.stdout) as {
      pid?: number;
      hostPid?: number;
    };
    assert.equal(daemonStatus.pid, workerPid);
    assert.equal(daemonStatus.hostPid, pid);
    const peerModels = await run(["models", "list", "--json"], project, peerEnv);
    assert.equal(peerModels.code, 0, peerModels.stderr);
    assert.deepEqual(
      (JSON.parse(peerModels.stdout) as { models: string[] }).models,
      ["openai/mock-model"]
    );
    // The peer must never start a competing daemon.
    assert.equal(existsSync(join(peerState, "services", "daemon.json")), false);
    // Owner-side commands must not harden the home back out of reach.
    assert.equal(statSync(ownerState).mode & 0o777, 0o711);

    const revoked = await run(
      ["token", "revoke", controlToken.id, "--json"],
      project,
      ownerEnv
    );
    assert.equal(revoked.code, 0, revoked.stderr);
    const afterRevoke = await run(["status"], project, peerEnv);
    assert.equal(afterRevoke.code, 1);
    assert.match(afterRevoke.stderr, /rejected this account's control token/);
    const modelsAfterRevoke = await run(["models", "list"], project, peerEnv);
    assert.equal(modelsAfterRevoke.code, 1);
    assert.match(modelsAfterRevoke.stderr, /rejected this account's control token/);

    const stopped = await run(["stop", "--json"], project, ownerEnv);
    assert.equal(stopped.code, 0, stopped.stderr);
    pid = undefined;
    assert.equal(existsSync(publicRecordPath), false);
    // A stopped shared daemon reads as "stopped", not as an auth failure.
    const afterStop = await run(["status", "--json"], project, peerEnv);
    assert.equal(afterStop.code, 0, afterStop.stderr);
    assert.equal(
      (JSON.parse(afterStop.stdout) as { daemon?: { running?: boolean } }).daemon
        ?.running,
      false
    );
    const modelsAfterStop = await run(["models", "list"], project, peerEnv);
    assert.equal(modelsAfterStop.code, 1);
    assert.match(modelsAfterStop.stderr, /shared RouteKit daemon is not running/);
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("peer add explains an unreadable owner home instead of reporting a missing file", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-peer-perm-"));
  const ownerHome = join(root, "owner-home");
  const peerHome = join(root, "peer-home");
  const project = join(root, "project");
  const publicRecordPath = join(
    ownerHome,
    ".routekit",
    "services",
    "daemon.public.json"
  );
  mkdirSync(dirname(publicRecordPath), { recursive: true });
  mkdirSync(peerHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    publicRecordPath,
    JSON.stringify({
      product: "routekit",
      kind: "daemon",
      url: "http://127.0.0.1:1",
      port: 1,
      generation: 1,
      protocolVersion: "control.v1",
      startedAt: new Date().toISOString()
    })
  );
  const peerEnv = {
    ...process.env,
    HOME: peerHome,
    ROUTEKIT_HOME: join(peerHome, ".routekit"),
    NO_COLOR: "1"
  };
  try {
    const absent = encodeJoinCredential({
      publicRecordPath: join(root, "absent", ".routekit", "services", "daemon.public.json"),
      token: "control-secret"
    });
    const missing = await run(["peer", "add", absent], project, peerEnv);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /public daemon record not found/);
    assert.match(missing.stderr, /fresh join credential/);

    if (process.getuid?.() === 0) return; // root bypasses mode bits
    chmodSync(publicRecordPath, 0o000);
    const deniedCredential = encodeJoinCredential({
      publicRecordPath,
      token: "control-secret"
    });
    const denied = await run(["peer", "add", deniedCredential], project, peerEnv);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /cannot read the public daemon record/);
    assert.match(denied.stderr, /chmod o\+x/);
  } finally {
    chmodSync(publicRecordPath, 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});
