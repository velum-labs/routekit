import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentProfile, ToolLaunchSpec } from "@velum-labs/routekit-tools";

import {
  codexAgentRoleToml,
  codexCatalogEntries,
  codexManagedTuiArgs,
  codexResumeCursor,
  codexResumeThreadId,
  createIsolatedCodexHome,
  codexLaunchConfigToml,
  codexModelCatalogJson,
  launchCodex,
  removeCodexNativeSession,
  resolveCodexHome
} from "../launch.js";

const SPEC: ToolLaunchSpec = {
  gatewayUrl: "http://127.0.0.1:9999",
  defaultModel: "opaque-primary",
  models: [
    {
      id: "opaque-primary",
      label: "Primary",
      aliases: ["primary-alias"],
      reasoning: {
        status: "supported",
        efforts: [{ id: "quick" }, { id: "deep" }],
        defaultEffort: "quick",
        provenance: "provider"
      }
    },
    {
      id: "opaque-secondary",
      reasoning: { status: "unknown", provenance: "unknown" }
    }
  ],
  args: []
};

const PROFILE: AgentProfile = {
  id: "reviewer",
  model: "opaque-secondary",
  description: "Review changes.",
  instructions: "Return concise findings."
};

test("Codex launcher serializes namespaced models without interpreting provider ids", () => {
  const template = {
    slug: "stock",
    display_name: "Stock",
    visibility: "list",
    supported_reasoning_levels: [{ effort: "template" }],
    default_reasoning_level: "template"
  };
  const entries = codexCatalogEntries(SPEC, template, [
    template,
    { slug: "opaque-secondary", display_name: "duplicate" }
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.slug),
    ["opaque-primary", "primary-alias", "opaque-secondary", "stock"]
  );
  assert.equal(entries[0]?.display_name, "Primary");
  assert.deepEqual(entries[0]?.supported_reasoning_levels, [
    { effort: "quick", description: "quick" },
    { effort: "deep", description: "deep" }
  ]);
  // Codex rejects the whole catalog file when any entry omits this field, so
  // undiscovered models must serialize an explicit empty list.
  assert.deepEqual(entries[2]?.supported_reasoning_levels, []);
  assert.equal(entries[2]?.default_reasoning_level, undefined);
  assert.ok(
    entries
      .slice(0, 3)
      .every((entry) => Array.isArray(entry.supported_reasoning_levels)),
    "every gateway-routed entry carries supported_reasoning_levels"
  );
  assert.deepEqual(JSON.parse(codexModelCatalogJson(SPEC, template)).models, entries.slice(0, 3));
});

test("Codex launcher filters incompatible OpenRouter models and aliases", () => {
  const spec: ToolLaunchSpec = {
    gatewayUrl: "http://127.0.0.1:9999",
    defaultModel: "openai/unknown",
    models: [
      { id: "openrouter/chat-only", provider: "openrouter", aliases: ["chat-alias"] },
      {
        id: "openrouter/reasoning",
        provider: "openrouter",
        aliases: ["reasoning-alias"],
        reasoning: { status: "supported", provenance: "provider" }
      },
      { id: "openai/unknown", provider: "openai", aliases: ["openai-alias"] }
    ],
    args: []
  };
  const entries = codexCatalogEntries(spec, { slug: "stock" }, [], {
    appendUnlistedStock: false
  });
  assert.deepEqual(
    entries.map((entry) => entry.slug),
    ["openai/unknown", "openrouter/reasoning", "reasoning-alias", "openai-alias"]
  );
});

test("Codex launcher retains an incompatible selected default deterministically", () => {
  const spec: ToolLaunchSpec = {
    gatewayUrl: "http://127.0.0.1:9999",
    defaultModel: "selected-alias",
    models: [
      {
        id: "openrouter/chat-only",
        provider: "openrouter",
        aliases: ["selected-alias", "second-alias"]
      },
      { id: "openrouter/hidden", provider: "openrouter", aliases: ["hidden-alias"] }
    ],
    args: []
  };
  assert.deepEqual(
    codexCatalogEntries(spec, { slug: "stock" }, [], {
      appendUnlistedStock: false
    }).map((entry) => entry.slug),
    ["selected-alias", "openrouter/chat-only", "second-alias"]
  );
});

test("Codex launcher exposes only provider-discovered Claude effort levels", () => {
  const spec: ToolLaunchSpec = {
    gatewayUrl: "http://127.0.0.1:9999",
    defaultModel: "claude-code/claude-fable-5",
    models: [
      {
        id: "claude-code/claude-fable-5",
        reasoning: {
          status: "supported",
          efforts: [{ id: "low" }, { id: "high" }, { id: "max" }],
          budget: { minTokens: 1_024 },
          adaptive: true,
          wireShape: "anthropic",
          provenance: "provider"
        }
      }
    ],
    args: []
  };
  const [entry] = codexCatalogEntries(spec, {
    slug: "stock",
    visibility: "list",
    supported_reasoning_levels: [{ effort: "template" }],
    default_reasoning_level: "template"
  });
  assert.deepEqual(entry?.supported_reasoning_levels, [
    { effort: "low", description: "low" },
    { effort: "high", description: "high" },
    { effort: "max", description: "max" }
  ]);
  assert.equal(entry?.default_reasoning_level, undefined);
});

test("Codex launcher neutralizes stock-model behavior fields from the template", () => {
  const template = {
    slug: "gpt-stock",
    display_name: "Stock",
    visibility: "list",
    supported_reasoning_levels: [{ effort: "medium" }],
    default_reasoning_level: "medium",
    // Real stock entries carry fields that change how Codex talks to the
    // model; none of them may leak into gateway-routed entries.
    tool_mode: "code_mode_only",
    use_responses_lite: true,
    additional_speed_tiers: ["fast"],
    service_tiers: [{ id: "priority", name: "Fast" }],
    default_service_tier: "priority",
    base_instructions: "You are Codex, an agent based on GPT-5.",
    model_messages: {
      instructions_template: "You are Codex, an agent based on GPT-5.",
      instructions_variables: null
    }
  };
  const [entry] = codexCatalogEntries(SPEC, template);
  assert.ok(entry);
  assert.equal("tool_mode" in entry, false);
  assert.equal("default_service_tier" in entry, false);
  assert.equal(entry.use_responses_lite, false);
  assert.deepEqual(entry.additional_speed_tiers, []);
  assert.deepEqual(entry.service_tiers, []);
  // The developer message must not claim a stock model's identity.
  assert.equal(entry.base_instructions, "You are a coding agent.");
  assert.deepEqual(entry.model_messages, {
    instructions_template: "You are a coding agent.",
    instructions_variables: null
  });
  // A minimal template gains no wire-shape fields it never had.
  const [minimal] = codexCatalogEntries(SPEC, { slug: "s", visibility: "list" });
  assert.ok(minimal);
  assert.equal("use_responses_lite" in minimal, false);
  assert.equal("service_tiers" in minimal, false);
});

test("Codex launcher passes stock ModelInfo through for codex-native models only", () => {
  const spec: ToolLaunchSpec = {
    gatewayUrl: "http://127.0.0.1:9999",
    defaultModel: "codex/gpt-5.5",
    models: [
      { id: "codex/gpt-5.5" },
      // A foreign model that happens to collide with a stock slug must NOT
      // inherit the stock entry: it is not the Codex-native model.
      { id: "claude-code/gpt-5.4" },
      { id: "claude-code/claude-sonnet-5" }
    ],
    args: []
  };
  const template = { slug: "stock", display_name: "Stock", visibility: "list" };
  const stock = [
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Stock Codex model.",
      base_instructions: "You are Codex, an agent based on GPT-5.",
      tool_mode: "code_mode_only",
      use_responses_lite: true,
      supported_reasoning_levels: [{ effort: "xhigh" }],
      default_reasoning_level: "xhigh",
      visibility: "hidden"
    },
    { slug: "gpt-5.4", display_name: "GPT-5.4" },
    { slug: "gpt-unrelated", display_name: "Unrelated" }
  ];
  const entries = codexCatalogEntries(spec, template, stock, {
    appendUnlistedStock: false
  });
  assert.deepEqual(
    entries.map((entry) => entry.slug),
    ["gpt-5.5", "claude-code/gpt-5.4", "claude-code/claude-sonnet-5"]
  );
  const [native, foreignCollision, foreign] = entries;
  // Native passthrough keeps the tuned stock behavior, pinned to list + HTTP.
  assert.equal(native?.base_instructions, "You are Codex, an agent based on GPT-5.");
  assert.equal(native?.tool_mode, "code_mode_only");
  assert.equal(native?.use_responses_lite, true);
  assert.equal(native?.default_reasoning_level, "xhigh");
  assert.equal(native?.visibility, "list");
  assert.equal(native?.prefer_websockets, false);
  // Foreign models never inherit stock entries, colliding slug or not.
  assert.equal(foreignCollision?.base_instructions, undefined);
  assert.equal("tool_mode" in (foreignCollision ?? {}), false);
  assert.equal("tool_mode" in (foreign ?? {}), false);
  // Unlisted stock models stay out when appending is disabled.
  assert.ok(!entries.some((entry) => entry.slug === "gpt-unrelated"));
});

test("Codex launcher serializes one gateway provider and generic agent profiles", () => {
  const role = { ...PROFILE, configPath: "/tmp/reviewer.toml" };
  const config = codexLaunchConfigToml(SPEC, "/tmp/catalog.json", [role]);
  assert.match(config, /model = "opaque-primary"/);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:9999\/v1"/);
  assert.match(config, /config_file = "\/tmp\/reviewer\.toml"/);

  const profile = codexAgentRoleToml(PROFILE);
  assert.match(profile, /model = "opaque-secondary"/);
  assert.match(profile, /developer_instructions = "Return concise findings\."/);
});

test("Codex launcher projects codex models to native picker ids", () => {
  const spec: ToolLaunchSpec = {
    gatewayUrl: "http://127.0.0.1:9999",
    defaultModel: "codex/gpt-5.5",
    models: [
      { id: "codex/gpt-5.5", label: "GPT-5.5 subscription" },
      { id: "claude-code/claude-sonnet-4-6" }
    ],
    args: []
  };
  const template = {
    slug: "stock",
    display_name: "Stock",
    visibility: "list"
  };
  assert.deepEqual(
    codexCatalogEntries(spec, template).map((entry) => [
      entry.slug,
      entry.display_name
    ]),
    [
      ["gpt-5.5", "GPT-5.5 subscription"],
      [
        "claude-code/claude-sonnet-4-6",
        "claude-code/claude-sonnet-4-6"
      ]
    ]
  );
  assert.match(codexLaunchConfigToml(spec), /model = "gpt-5\.5"/);
  assert.match(
    codexAgentRoleToml({
      ...PROFILE,
      model: "codex/gpt-5.5"
    }),
    /model = "gpt-5\.5"/
  );
});

test("isolated Codex homes live under the user cache instead of the system temp root", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-codex-home-test-"));
  const userHome = join(root, "home");
  try {
    const isolated = createIsolatedCodexHome("driver-", { HOME: userHome });
    assert.ok(
      isolated.startsWith(join(userHome, ".cache", "routekit", "codex", "driver-"))
    );
    assert.equal(existsSync(isolated), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("Codex managed resume uses global remote options before exact native UUID", () => {
  const threadId = "123e4567-e89b-42d3-a456-426614174000";
  const spec: ToolLaunchSpec = {
    ...SPEC,
    args: ["--no-alt-screen"],
    session: { mode: "resume", cursor: codexResumeCursor(threadId) }
  };
  assert.deepEqual(codexManagedTuiArgs(spec, "unix:///private/socket", ["-c", 'model="opaque-primary"']), [
    "--remote", "unix:///private/socket", "-c", 'model="opaque-primary"',
    "resume", threadId, "--no-alt-screen"
  ]);
  assert.equal(codexResumeThreadId(spec.session!.mode === "resume" ? spec.session!.cursor : codexResumeCursor(threadId)), threadId);
});

test("Codex managed launch rejects native session-selection arguments", () => {
  const spec: ToolLaunchSpec = { ...SPEC, args: ["--last"], session: { mode: "new" } };
  assert.throws(() => codexManagedTuiArgs(spec, "unix:///private/socket", []), /cannot forward --last/);
});

test("Codex normal home honors absolute CODEX_HOME and rejects relative values", () => {
  assert.equal(resolveCodexHome({ CODEX_HOME: "/private/codex" }), "/private/codex");
  assert.throws(() => resolveCodexHome({ CODEX_HOME: "relative" }), /absolute path/);
});

test("Codex cursors fail closed on invalid or incompatible native identity", () => {
  assert.throws(() => codexResumeCursor("not-a-uuid"), /invalid Codex thread id/);
  assert.throws(
    () => codexResumeThreadId({ version: 2, kind: "codex", data: { threadId: "123e4567-e89b-42d3-a456-426614174000" } }),
    /compatible codex cursor/
  );
});


function fakeCodex(root: string): { bin: string; log: string; protocolLog: string } {
  const bin = join(root, "codex");
  const log = join(root, "argv.jsonl");
  const protocolLog = join(root, "protocol.jsonl");
  writeFileSync(bin, `#!/usr/bin/env node
const crypto = require("node:crypto");
const net = require("node:net");
const fs = require("node:fs");
const args = process.argv.slice(2);
const record = (value) => fs.appendFileSync(process.env.FAKE_CODEX_PROTOCOL_LOG, JSON.stringify(value) + "\\n");
const accept = (key) => crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
const serverFrame = (opcode, payload = Buffer.alloc(0), fin = true) => {
  const ext = payload.length < 126 ? 0 : 2;
  const out = Buffer.alloc(2 + ext + payload.length);
  out[0] = (fin ? 0x80 : 0) | opcode;
  out[1] = ext ? 126 : payload.length;
  if (ext) out.writeUInt16BE(payload.length, 2);
  payload.copy(out, 2 + ext);
  return out;
};
const parseClientFrame = (buffer) => {
  if (buffer.length < 2) return;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f, offset = 2;
  if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
  if (!masked) throw new Error("client frame was not masked");
  if (buffer.length < offset + 4 + length) return;
  const mask = buffer.subarray(offset, offset + 4), payload = Buffer.alloc(length);
  for (let i = 0; i < length; i++) payload[i] = buffer[offset + 4 + i] ^ mask[i % 4];
  return { opcode: buffer[0] & 15, payload, rest: buffer.subarray(offset + 4 + length) };
};
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("codex-cli " + (process.env.FAKE_CODEX_VERSION || "0.146.0")); process.exit(0); }
if (args[0] === "delete") process.exit(process.env.FAKE_CODEX_DELETE_FAIL === "1" ? 7 : 0);
if (args[0] === "app-server") {
  const endpoint = args[args.indexOf("--listen") + 1];
  const path = endpoint.slice("unix://".length);
  try { fs.unlinkSync(path); } catch {}
  const clients = new Set();
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0), open = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!open) {
        const boundary = buffer.indexOf("\\r\\n\\r\\n");
        if (boundary < 0) return;
        const header = buffer.subarray(0, boundary).toString("latin1");
        record({ type: "handshake", header, rawJsonl: header.startsWith("{") });
        const key = /sec-websocket-key:\\s*(.+)/i.exec(header)?.[1]?.trim();
        if (!key) return socket.destroy();
        socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept(key) + "\\r\\n\\r\\n");
        open = true; clients.add(socket); buffer = buffer.subarray(boundary + 4);
      }
      while (open) {
        const frame = parseClientFrame(buffer); if (!frame) break; buffer = frame.rest;
        record({ type: "client-frame", opcode: frame.opcode, masked: true });
        if (frame.opcode === 1) {
          const message = JSON.parse(frame.payload.toString());
          record({ type: "rpc", method: message.method });
          if (message.method === "initialize") socket.write(serverFrame(1, Buffer.from(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }))));
        } else if (frame.opcode === 9) socket.write(serverFrame(10, frame.payload));
      }
    });
    socket.on("close", () => clients.delete(socket));
  });
  server.listen(path);
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  setInterval(() => {
    const signal = path + ".thread";
    if (!fs.existsSync(signal)) return;
    const id = fs.readFileSync(signal, "utf8"); fs.unlinkSync(signal);
    const json = Buffer.from(JSON.stringify({ method: "thread/started", params: { thread: { id } } }));
    const split = Math.floor(json.length / 2);
    for (const client of clients) {
      client.write(serverFrame(9, Buffer.from("ping")));
      client.write(serverFrame(1, json.subarray(0, split), false));
      client.write(serverFrame(0, json.subarray(split), true));
    }
  }, 10);
} else {
  const endpoint = args[args.indexOf("--remote") + 1];
  const path = endpoint.slice("unix://".length);
  fs.writeFileSync(path + ".thread", process.env.FAKE_CODEX_THREAD_ID);
  setTimeout(() => process.exit(0), 100);
}
`);
  chmodSync(bin, 0o755);
  return { bin, log, protocolLog };
}

test("managed Codex app-server handshake durably publishes thread/started and cleans up", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-codex-fake-"));
  const { bin, log, protocolLog } = fakeCodex(root);
  const threadId = "123e4567-e89b-42d3-a456-426614174000";
  const previous = { path: process.env.PATH, log: process.env.FAKE_CODEX_LOG, protocol: process.env.FAKE_CODEX_PROTOCOL_LOG, id: process.env.FAKE_CODEX_THREAD_ID };
  process.env.PATH = `${root}:${process.env.PATH ?? ""}`;
  process.env.FAKE_CODEX_LOG = log;
  process.env.FAKE_CODEX_PROTOCOL_LOG = protocolLog;
  process.env.FAKE_CODEX_THREAD_ID = threadId;
  const disposers: Array<() => void | Promise<void>> = [];
  let published: unknown;
  try {
    const result = await launchCodex({
      spec: { ...SPEC, session: { mode: "new" } },
      log: () => {}, prepareForPassthrough: () => {}, registerPort: () => "", unregisterPort: () => {},
      registerDisposer: (dispose) => disposers.push(dispose),
      publishResumeCursor: async (cursor) => { await new Promise((resolve) => setTimeout(resolve, 10)); published = cursor; }
    }, { env: { ...process.env, HOME: root } });
    assert.deepEqual(result.resumeCursor, codexResumeCursor(threadId));
    assert.deepEqual(published, result.resumeCursor);
    const invocations = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(invocations.some((args) => args[0] === "app-server" && args.includes("--listen")));
    assert.ok(invocations.some((args) => args.includes("--remote")));
    const protocol = readFileSync(protocolLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(protocol.some((entry) => entry.type === "handshake" && entry.rawJsonl === false && /Upgrade: websocket/i.test(entry.header)));
    assert.ok(protocol.some((entry) => entry.type === "client-frame" && entry.masked === true));
    assert.deepEqual(protocol.filter((entry) => entry.type === "rpc").map((entry) => entry.method), ["initialize", "initialized"]);
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    process.env.PATH = previous.path;
    if (previous.log === undefined) delete process.env.FAKE_CODEX_LOG; else process.env.FAKE_CODEX_LOG = previous.log;
    if (previous.protocol === undefined) delete process.env.FAKE_CODEX_PROTOCOL_LOG; else process.env.FAKE_CODEX_PROTOCOL_LOG = previous.protocol;
    if (previous.id === undefined) delete process.env.FAKE_CODEX_THREAD_ID; else process.env.FAKE_CODEX_THREAD_ID = previous.id;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex exact deletion reports native failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-codex-delete-"));
  const { log } = fakeCodex(root);
  const previous = process.env.PATH;
  process.env.PATH = `${root}:${previous ?? ""}`;
  process.env.FAKE_CODEX_LOG = log;
  const cursor = codexResumeCursor("123e4567-e89b-42d3-a456-426614174000");
  try {
    await removeCodexNativeSession(cursor, { env: { ...process.env, CODEX_HOME: root } });
    process.env.FAKE_CODEX_DELETE_FAIL = "1";
    await assert.rejects(removeCodexNativeSession(cursor, { env: { ...process.env, CODEX_HOME: root } }), /could not delete native session/);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!), ["delete", "123e4567-e89b-42d3-a456-426614174000", "--force"]);
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    delete process.env.FAKE_CODEX_LOG;
    delete process.env.FAKE_CODEX_DELETE_FAIL;
    rmSync(root, { recursive: true, force: true });
  }
});
