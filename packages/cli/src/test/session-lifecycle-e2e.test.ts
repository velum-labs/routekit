import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

async function runCli(args: readonly string[], input: { cwd: string; env: NodeJS.ProcessEnv }) {
  try {
    const result = await execFileAsync(process.execPath, [CLI_ENTRY, ...args], {
      cwd: input.cwd,
      env: input.env,
      encoding: "utf8",
      timeout: 30_000
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      status: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? ""
    };
  }
}

async function mustRun(args: readonly string[], input: { cwd: string; env: NodeJS.ProcessEnv }) {
  const result = await runCli(args, input);
  assert.equal(
    result.status,
    0,
    `routekit ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`
  );
  return result;
}

test("managed Claude sessions survive processes and resume without replacement", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "routekit-session-lifecycle-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const transcript = join(root, "claude.jsonl");
  mkdirSync(project);
  mkdirSync(home);
  mkdirSync(bin);

  const gateway = createServer((request, response) => {
    if (request.url !== "/v1/models") {
      response.writeHead(404).end();
      return;
    }
    assert.equal(request.headers.authorization, "Bearer remote-token");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        default_model: "anthropic/claude-sonnet-4-6",
        data: [
          {
            id: "anthropic/claude-sonnet-4-6",
            owned_by: "anthropic",
            capabilities: { streaming: "supported", tools: "supported" }
          }
        ]
      })
    );
  });
  await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
  t.after(() => {
    gateway.close();
    rmSync(root, { recursive: true, force: true });
  });
  const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

  writeFileSync(join(bin, "security"), "#!/bin/sh\nprintf '%s\\n' remote-token\n", { mode: 0o700 });
  chmodSync(join(bin, "security"), 0o700);
  writeFileSync(
    join(bin, "claude"),
    [
      `#!${process.execPath}`,
      "const { appendFileSync, existsSync, readFileSync } = require('node:fs');",
      `const path = ${JSON.stringify(transcript)};`,
      "const count = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\\n').filter(Boolean).length : 0;",
      "appendFileSync(path, JSON.stringify(process.argv.slice(2)) + '\\n');",
      "process.exit(count === 3 ? 7 : 0);"
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(join(bin, "claude"), 0o700);
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "remotes.json"),
    JSON.stringify({
      version: 1,
      active: "test",
      remotes: [{ name: "test", gatewayUrl, sshHost: "test", addedAt: new Date(0).toISOString() }]
    })
  );

  const input = {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      ROUTEKIT_HOME: state,
      ROUTEKIT_TELEMETRY: "0",
      ROUTEKIT_NO_TUI: "1",
      NO_COLOR: "1",
      PATH: `${bin}:${process.env.PATH ?? ""}`
    }
  };

  await mustRun(["claude", "anthropic/claude-sonnet-4-6"], input);
  const listed = JSON.parse((await mustRun(["sessions", "list", "--json"], input)).stdout) as {
    sessions: Array<{ id: string; status: string; target: unknown; cwd: string }>;
  };
  assert.equal(listed.sessions.length, 1);
  const id = listed.sessions[0]!.id;
  assert.equal(listed.sessions[0]!.status, "resumable");
  assert.deepEqual(listed.sessions[0]!.target, { kind: "remote", name: "test" });
  assert.equal(listed.sessions[0]!.cwd, realpathSync(project));

  const shown = JSON.parse((await mustRun(["sessions", "show", id, "--json"], input)).stdout) as {
    id: string;
  };
  assert.equal(shown.id, id);
  await mustRun(["claude", "--resume", id], input);
  await mustRun(["claude", "--continue"], input);

  const failedResume = await runCli(["claude", "--resume", id], input);
  assert.equal(failedResume.status, 7);
  const afterFailure = JSON.parse(
    (await mustRun(["sessions", "show", id, "--json"], input)).stdout
  ) as {
    id: string;
    status: string;
  };
  assert.equal(afterFailure.status, "resumable");
  assert.equal(
    (
      JSON.parse((await mustRun(["sessions", "list", "--json"], input)).stdout) as {
        sessions: unknown[];
      }
    ).sessions.length,
    1
  );

  const launches = readFileSync(transcript, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(launches.length, 4);
  assert.ok(launches[0]!.includes("--session-id"));
  assert.ok(launches.slice(1).every((args) => args.includes("--resume")));

  const removed = JSON.parse(
    (await mustRun(["--yes", "sessions", "rm", id, "--json"], input)).stdout
  ) as {
    removed: boolean;
    nativeSessionRemoved: boolean;
  };
  assert.deepEqual(removed, { removed: true, id, nativeSessionRemoved: false });
  assert.deepEqual(
    (
      JSON.parse((await mustRun(["sessions", "list", "--json"], input)).stdout) as {
        sessions: unknown[];
      }
    ).sessions,
    []
  );
});


function writeFakeCodex(input: { bin: string; transcript: string }): void {
  const executable = join(input.bin, "codex");
  writeFileSync(executable, `#!${process.execPath}
const crypto = require("node:crypto");
const net = require("node:net");
const fs = require("node:fs");
const transcript = ${JSON.stringify(input.transcript)};
const args = process.argv.slice(2);
const record = (entry) => fs.appendFileSync(transcript, JSON.stringify(entry) + "\\n");
const accept = (key) => crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
const frame = (opcode, payload = Buffer.alloc(0)) => {
  const ext = payload.length < 126 ? 0 : 2;
  const out = Buffer.alloc(2 + ext + payload.length);
  out[0] = 0x80 | opcode; out[1] = ext ? 126 : payload.length;
  if (ext) out.writeUInt16BE(payload.length, 2);
  payload.copy(out, 2 + ext); return out;
};
const maskedFrame = (opcode, payload) => {
  const mask = crypto.randomBytes(4), ext = payload.length < 126 ? 0 : 2;
  const out = Buffer.alloc(2 + ext + 4 + payload.length);
  out[0] = 0x80 | opcode; out[1] = 0x80 | (ext ? 126 : payload.length);
  if (ext) out.writeUInt16BE(payload.length, 2);
  const offset = 2 + ext; mask.copy(out, offset);
  for (let i = 0; i < payload.length; i++) out[offset + 4 + i] = payload[i] ^ mask[i % 4];
  return out;
};
const parseFrame = (buffer, requireMask) => {
  if (buffer.length < 2) return;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 127, offset = 2;
  if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
  if (requireMask && !masked) throw new Error("client frame was not masked");
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + length) return;
  const payload = Buffer.alloc(length), mask = buffer.subarray(offset, offset + maskBytes);
  for (let i = 0; i < length; i++) payload[i] = buffer[offset + maskBytes + i] ^ (masked ? mask[i % 4] : 0);
  return { opcode: buffer[0] & 15, payload, masked, rest: buffer.subarray(offset + maskBytes + length) };
};
const upgradeClient = (socket, socketPath, onOpen, onFrame) => {
  const key = crypto.randomBytes(16).toString("base64");
  let buffer = Buffer.alloc(0), open = false;
  socket.on("connect", () => socket.write("GET / HTTP/1.1\\r\\nHost: localhost\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: " + key + "\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n"));
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!open) {
      const boundary = buffer.indexOf("\\r\\n\\r\\n"); if (boundary < 0) return;
      const header = buffer.subarray(0, boundary).toString("latin1");
      if (!header.startsWith("HTTP/1.1 101") || !header.includes(accept(key))) throw new Error("bad upgrade");
      open = true; buffer = buffer.subarray(boundary + 4); onOpen(socket);
    }
    while (open) { const parsed = parseFrame(buffer, false); if (!parsed) break; buffer = parsed.rest; onFrame(socket, parsed); }
  });
};
record({ type: "argv", pid: process.pid, args, codexHome: process.env.CODEX_HOME });
if (args[0] === "--version") { console.log("codex-cli " + (process.env.FAKE_CODEX_VERSION || "0.146.0")); process.exit(0); }
if (args[0] === "delete") { record({ type: "delete", args }); process.exit(process.env.FAKE_CODEX_DELETE_FAIL === "1" ? 9 : 0); }
const remoteIndex = args.indexOf("--remote");
if (args[0] !== "app-server" && remoteIndex >= 0) {
  const socketPath = args[remoteIndex + 1].slice("unix://".length);
  const socket = net.createConnection(socketPath);
  upgradeClient(socket, socketPath, (open) => open.write(maskedFrame(1, Buffer.from(JSON.stringify({ method: "fake/tui-connected", params: { threadId: process.env.FAKE_CODEX_THREAD_ID } })))), (_open, parsed) => {
    if (parsed.opcode === 1 && JSON.parse(parsed.payload.toString()).method === "fake/thread-broadcast") socket.end();
  });
  socket.on("end", () => process.exit(0));
  socket.on("error", (error) => { console.error(error.message); process.exit(8); });
  setTimeout(() => process.exit(8), 5000).unref();
} else if (args[0] === "app-server") {
  const endpoint = args[args.indexOf("--listen") + 1], socketPath = endpoint.slice("unix://".length);
  try { fs.unlinkSync(socketPath); } catch {}
  const clients = new Set();
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0), open = false;
    socket.on("close", () => clients.delete(socket));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!open) {
        const boundary = buffer.indexOf("\\r\\n\\r\\n"); if (boundary < 0) return;
        const header = buffer.subarray(0, boundary).toString("latin1");
        record({ type: "handshake", pid: process.pid, rawJsonl: header.startsWith("{"), header });
        const key = /sec-websocket-key:\\s*(.+)/i.exec(header)?.[1]?.trim(); if (!key) return socket.destroy();
        socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept(key) + "\\r\\n\\r\\n");
        open = true; clients.add(socket); buffer = buffer.subarray(boundary + 4);
      }
      while (open) {
        const parsed = parseFrame(buffer, true); if (!parsed) break; buffer = parsed.rest;
        record({ type: "client-frame", pid: process.pid, opcode: parsed.opcode, masked: parsed.masked });
        if (parsed.opcode !== 1) continue;
        const message = JSON.parse(parsed.payload.toString());
        record({ type: "rpc", pid: process.pid, method: message.method, params: message.params });
        if (message.method === "initialize") socket.write(frame(1, Buffer.from(JSON.stringify({ id: message.id, result: { userAgent: "fake-codex" } }))));
        else if (message.method === "fake/tui-connected") {
          const threadId = message.params.threadId;
          const started = frame(1, Buffer.from(JSON.stringify({ method: "thread/started", params: { thread: { id: threadId } } })));
          for (const client of clients) client.write(started);
          socket.write(frame(1, Buffer.from(JSON.stringify({ method: "fake/thread-broadcast" }))));
          record({ type: "broadcast", pid: process.pid, threadId });
        }
      }
    });
  });
  server.listen(socketPath, () => record({ type: "listening", pid: process.pid, socketPath }));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  setInterval(() => {}, 1000);
} else { process.exit(8); }
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
}

type CodexTranscriptEntry = {
  type: "argv" | "rpc" | "broadcast" | "delete" | "listening" | "handshake" | "client-frame";
  pid?: number;
  args?: string[];
  method?: string;
  params?: unknown;
  threadId?: string;
  socketPath?: string;
  codexHome?: string;
  rawJsonl?: boolean;
  header?: string;
  opcode?: number;
  masked?: boolean;
};

function readCodexTranscript(path: string): CodexTranscriptEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CodexTranscriptEntry);
}

function codexArgv(entries: readonly CodexTranscriptEntry[]): string[][] {
  return entries.flatMap((entry) => (entry.type === "argv" && entry.args !== undefined ? [entry.args] : []));
}

test("managed Codex sessions use app-server across CLI processes and delete exactly", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "routekit-codex-session-e2e-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const transcript = join(root, "codex.jsonl");
  const threadId = "123e4567-e89b-42d3-a456-426614174000";
  for (const directory of [project, home, codexHome, state, bin]) mkdirSync(directory);
  writeFakeCodex({ bin, transcript });
  writeFileSync(join(bin, "security"), "#!/bin/sh\nprintf '%s\\n' remote-token\n", { mode: 0o700 });
  chmodSync(join(bin, "security"), 0o700);

  let gatewayModel = "codex/gpt-5.5";
  const gateway = createServer((request, response) => {
    if (request.url !== "/v1/models") {
      response.writeHead(404).end();
      return;
    }
    assert.equal(request.headers.authorization, "Bearer remote-token");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        default_model: gatewayModel,
        data: [
          { id: "codex/gpt-5.5", owned_by: "codex", capabilities: { streaming: "supported", tools: "supported" } },
          { id: "codex/gpt-5.6", owned_by: "codex", capabilities: { streaming: "supported", tools: "supported" } }
        ]
      })
    );
  });
  await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
  t.after(() => {
    gateway.close();
    rmSync(root, { recursive: true, force: true });
  });
  const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  writeFileSync(
    join(state, "remotes.json"),
    JSON.stringify({
      version: 1,
      active: "test",
      remotes: [{ name: "test", gatewayUrl, sshHost: "test", addedAt: new Date(0).toISOString() }]
    })
  );
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    ROUTEKIT_HOME: state,
    ROUTEKIT_TELEMETRY: "0",
    ROUTEKIT_NO_TUI: "1",
    NO_COLOR: "1",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FAKE_CODEX_THREAD_ID: threadId,
    FAKE_CODEX_VERSION: "0.146.0"
  };
  const input = { cwd: project, env: baseEnv };

  await mustRun(["codex", "codex/gpt-5.5"], input);
  const listed = JSON.parse((await mustRun(["sessions", "list", "--json"], input)).stdout) as {
    sessions: Array<{ id: string; tool: string; model: string; resume: { data: { threadId: string } }; target: unknown }>;
  };
  assert.equal(listed.sessions.length, 1);
  const routekitId = listed.sessions[0]!.id;
  assert.equal(listed.sessions[0]!.tool, "codex");
  assert.equal(listed.sessions[0]!.model, "codex/gpt-5.5");
  assert.equal(listed.sessions[0]!.resume.data.threadId, threadId);
  assert.deepEqual(listed.sessions[0]!.target, { kind: "remote", name: "test" });
  const shown = JSON.parse((await mustRun(["sessions", "show", routekitId, "--json"], input)).stdout) as {
    id: string;
    resume: { data: { threadId: string } };
  };
  assert.equal(shown.id, routekitId);
  assert.equal(shown.resume.data.threadId, threadId);

  // Change the remote default to prove resume restores the stored model.
  gatewayModel = "codex/gpt-5.6";
  await mustRun(["codex", "--resume", routekitId], input);
  await mustRun(["codex", "--continue"], input);
  const afterResume = JSON.parse((await mustRun(["sessions", "list", "--json"], input)).stdout) as {
    sessions: Array<{ id: string; model: string; resume: { data: { threadId: string } } }>;
  };
  assert.equal(afterResume.sessions.length, 1, "resume and continue must not enroll replacements");
  assert.equal(afterResume.sessions[0]!.id, routekitId);
  assert.equal(afterResume.sessions[0]!.model, "codex/gpt-5.5");
  assert.equal(afterResume.sessions[0]!.resume.data.threadId, threadId);

  const beforeDelete = readCodexTranscript(transcript);
  const appServers = beforeDelete.filter((entry) => entry.type === "argv" && entry.args?.[0] === "app-server");
  assert.equal(appServers.length, 3);
  assert.equal(new Set(appServers.map((entry) => entry.pid)).size, 3, "each launch uses a dedicated app-server process");
  assert.ok(appServers.every((entry) => entry.args?.some((arg) => arg.startsWith("unix://"))));
  assert.equal(beforeDelete.filter((entry) => entry.type === "rpc" && entry.method === "initialize").length, 3);
  assert.equal(beforeDelete.filter((entry) => entry.type === "rpc" && entry.method === "initialized").length, 3);
  assert.equal(beforeDelete.filter((entry) => entry.type === "handshake" && entry.rawJsonl === false).length, 6);
  assert.ok(beforeDelete.filter((entry) => entry.type === "client-frame").every((entry) => entry.masked === true));
  assert.equal(beforeDelete.filter((entry) => entry.type === "broadcast" && entry.threadId === threadId).length, 3);
  const tuiArgs = codexArgv(beforeDelete).filter((args) => args.includes("--remote") && args[0] !== "app-server");
  assert.equal(tuiArgs.length, 3);
  assert.ok(tuiArgs.slice(1).every((args) => {
    const resume = args.indexOf("resume");
    return resume >= 0 && args[resume + 1] === threadId;
  }));
  assert.ok(tuiArgs.every((args) => args.some((arg) => arg === 'model="gpt-5.5"')));
  assert.ok(beforeDelete.filter((entry) => entry.type === "listening").every((entry) => entry.socketPath?.endsWith("server.sock")));
  assert.ok(beforeDelete.filter((entry) => entry.type === "argv").every((entry) => entry.codexHome === codexHome));

  const failedDelete = await runCli(["--yes", "sessions", "rm", routekitId, "--json"], {
    ...input,
    env: { ...baseEnv, FAKE_CODEX_DELETE_FAIL: "1" }
  });
  assert.equal(failedDelete.status, 1);
  assert.equal(
    (JSON.parse((await mustRun(["sessions", "list", "--json"], input)).stdout) as { sessions: unknown[] }).sessions.length,
    1,
    "native deletion failure must preserve RouteKit metadata"
  );

  const removed = JSON.parse(
    (await mustRun(["--yes", "sessions", "rm", routekitId, "--json"], input)).stdout
  ) as { removed: boolean; id: string; nativeSessionRemoved: boolean };
  assert.deepEqual(removed, { removed: true, id: routekitId, nativeSessionRemoved: true });
  assert.deepEqual(
    (JSON.parse((await mustRun(["sessions", "list", "--json"], input)).stdout) as { sessions: unknown[] }).sessions,
    []
  );
  const deletes = readCodexTranscript(transcript).filter((entry) => entry.type === "delete");
  assert.equal(deletes.length, 2);
  assert.ok(deletes.every((entry) => JSON.stringify(entry.args) === JSON.stringify(["delete", threadId, "--force"])));
});

test("managed Codex rejects incompatible CLI before enrollment", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "routekit-codex-version-e2e-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const transcript = join(root, "codex.jsonl");
  for (const directory of [project, home, state, bin]) mkdirSync(directory);
  writeFakeCodex({ bin, transcript });
  writeFileSync(join(bin, "security"), "#!/bin/sh\nprintf '%s\\n' remote-token\n", { mode: 0o700 });
  chmodSync(join(bin, "security"), 0o700);
  const gateway = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ default_model: "codex/gpt-5.5", data: [{ id: "codex/gpt-5.5", owned_by: "codex", capabilities: {} }] }));
  });
  await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
  t.after(() => { gateway.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(state, "remotes.json"), JSON.stringify({
    version: 1,
    active: "test",
    remotes: [{ name: "test", gatewayUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`, sshHost: "test", addedAt: new Date(0).toISOString() }]
  }));
  const input = {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      ROUTEKIT_HOME: state,
      ROUTEKIT_TELEMETRY: "0",
      ROUTEKIT_NO_TUI: "1",
      NO_COLOR: "1",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_CODEX_VERSION: "0.145.0",
      FAKE_CODEX_THREAD_ID: "123e4567-e89b-42d3-a456-426614174000"
    }
  };
  const result = await runCli(["codex", "codex/gpt-5.5"], input);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /require Codex CLI >=0\.146\.0/);
  assert.deepEqual(
    (JSON.parse((await mustRun(["sessions", "list", "--json"], input)).stdout) as { sessions: unknown[] }).sessions,
    []
  );
  assert.deepEqual(codexArgv(readCodexTranscript(transcript)), [["--version"]]);
});
