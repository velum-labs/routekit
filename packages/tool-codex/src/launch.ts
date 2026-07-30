import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  isCodexPickerEligibleModel,
  reasoningEffortDescriptors
} from "@velum-labs/routekit-contracts";
import { trimTrailingSlashes } from "@velum-labs/routekit-runtime";
import type {
  AgentProfile,
  ToolLaunchContext,
  ToolLaunchResult,
  ToolLaunchSpec
} from "@velum-labs/routekit-tools";
import { stringify as tomlStringify } from "smol-toml";

const PROVIDER_ID = "routekit";
const CATALOG_FILE = "model-catalog.json";
/** Model-agnostic agent prompt, matching the gateway's synthesized entries. */
const NEUTRAL_INSTRUCTIONS = "You are a coding agent.";
const PROFILE_DIR = "agent-profiles";
const CONFIG_FAILURE_PATTERNS: readonly RegExp[] = [
  /config\.toml/i,
  /model_catalog/i,
  /duplicate agent role/i,
  /error (?:reading|parsing|loading) config/i,
  /invalid config/i,
  /unknown field/i,
  /missing field/i,
  /agent role/i
];

export type CodexModelPreset = Record<string, unknown>;

export function isCodexConfigFailure(code: number, stderr: string): boolean {
  return code !== 0 && CONFIG_FAILURE_PATTERNS.some((pattern) => pattern.test(stderr));
}

export function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function modelsCachePath(home: string): string {
  return join(home, ".codex", "models_cache.json");
}

function readCodexModelsCachePath(path: string): CodexModelPreset[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { models?: unknown };
    return Array.isArray(parsed.models)
      ? parsed.models.filter(
          (entry): entry is CodexModelPreset => entry !== null && typeof entry === "object"
        )
      : [];
  } catch {
    return [];
  }
}

export function readCodexModelsCache(home: string = homedir()): CodexModelPreset[] {
  return readCodexModelsCachePath(modelsCachePath(home));
}

function readCodexHomeModelsCache(codexHome: string): CodexModelPreset[] {
  return readCodexModelsCachePath(join(codexHome, "models_cache.json"));
}

export function readCodexCatalogTemplate(home: string = homedir()): CodexModelPreset | undefined {
  return readCodexModelsCache(home)[0];
}

export function codexAuthPath(home: string = homedir()): string {
  return join(home, ".codex", "auth.json");
}

export function hasCodexLogin(home: string = homedir()): boolean {
  return existsSync(codexAuthPath(home));
}

/**
 * Create an isolated Codex home outside the operating-system temp directory.
 *
 * Recent Codex releases refuse to install their process-scoped PATH helpers
 * beneath `tmpdir()`. RouteKit still needs an isolated home so a gateway turn
 * cannot read or mutate the user's real Codex configuration.
 */
export function createIsolatedCodexHome(
  prefix: string,
  env: Record<string, string | undefined> = process.env
): string {
  const userHome = env.HOME ?? env.USERPROFILE ?? homedir();
  const cacheRoot =
    env.XDG_CACHE_HOME ??
    (process.platform === "win32" ? env.LOCALAPPDATA : undefined) ??
    join(userHome, ".cache");
  const parent = join(cacheRoot, "routekit", "codex");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(parent, prefix));
}

function presetSlug(entry: CodexModelPreset): string | undefined {
  return typeof entry.slug === "string" && entry.slug.length > 0 ? entry.slug : undefined;
}

export function codexListedStockSlugs(home: string = homedir()): string[] {
  const seen = new Set<string>();
  return readCodexModelsCache(home).flatMap((entry) => {
    const slug = presetSlug(entry);
    if (slug === undefined || seen.has(slug)) return [];
    seen.add(slug);
    return [slug];
  });
}

function codexModelId(modelId: string): string {
  return modelId.startsWith("codex/") ? modelId.slice("codex/".length) : modelId;
}

function catalogModels(
  spec: Pick<ToolLaunchSpec, "defaultModel" | "models">
): ToolLaunchSpec["models"] {
  return spec.models.filter(
    (model) =>
      model.id === spec.defaultModel ||
      model.aliases?.includes(spec.defaultModel) === true ||
      isCodexPickerEligibleModel(model)
  );
}

function catalogIds(spec: Pick<ToolLaunchSpec, "defaultModel" | "models">): string[] {
  return [
    ...new Set(
      [
        spec.defaultModel,
        ...catalogModels(spec).flatMap((model) => [model.id, ...(model.aliases ?? [])])
      ].map(codexModelId)
    )
  ];
}

/** True when a bare catalog id was projected from a `codex/`-namespaced model. */
function isCodexNativeId(
  spec: Pick<ToolLaunchSpec, "defaultModel" | "models">,
  id: string
): boolean {
  const namespaced = `codex/${id}`;
  return (
    spec.defaultModel === namespaced ||
    spec.models.some(
      (model) => model.id === namespaced || model.aliases?.includes(namespaced) === true
    )
  );
}

export function codexCatalogEntries(
  spec: Pick<ToolLaunchSpec, "defaultModel" | "models">,
  template: CodexModelPreset,
  stockModels: readonly CodexModelPreset[] = [],
  options: { appendUnlistedStock?: boolean } = {}
): Record<string, unknown>[] {
  const appendUnlistedStock = options.appendUnlistedStock ?? true;
  const models = catalogModels(spec);
  const ids = catalogIds(spec);
  const listed = new Set(ids);
  const stockBySlug = new Map(
    stockModels.flatMap((entry) => {
      const slug = presetSlug(entry);
      return slug === undefined ? [] : [[slug, entry] as const];
    })
  );
  // The template (a stock Codex model entry) only exists to satisfy the
  // catalog schema of the installed Codex version. Fields that change how
  // Codex talks to the model must not leak from an unrelated stock model into
  // gateway-routed entries: reasoning tiers are replaced by each model's
  // discovered capabilities; `tool_mode` (e.g. "code_mode_only") and
  // `use_responses_lite` alter (or drop entirely) the tool declarations Codex
  // sends; service tiers are a stock-model billing offer; and
  // `base_instructions` / `model_messages` become the developer message, so a
  // stock prompt ("You are Codex, an agent based on GPT-5...") would tell
  // every routed model it is GPT-5. Fields are reset to neutral values only
  // when the template carries them, so the output still matches the installed
  // Codex version's required fields.
  const {
    supported_reasoning_levels: _templateLevels,
    default_reasoning_level: _templateDefault,
    supports_reasoning_summaries: _templateSummaries,
    tool_mode: _templateToolMode,
    default_service_tier: _templateServiceTier,
    ...neutralTemplate
  } = template;
  for (const [field, neutral] of [
    ["use_responses_lite", false],
    ["additional_speed_tiers", []],
    ["service_tiers", []],
    ["base_instructions", NEUTRAL_INSTRUCTIONS]
  ] as const) {
    if (field in neutralTemplate) neutralTemplate[field] = neutral;
  }
  if (
    typeof neutralTemplate.model_messages === "object" &&
    neutralTemplate.model_messages !== null
  ) {
    neutralTemplate.model_messages = {
      ...neutralTemplate.model_messages,
      instructions_template: NEUTRAL_INSTRUCTIONS
    };
  }
  const entries: Record<string, unknown>[] = ids.map((id, priority) => {
    // A Codex-native model whose real ModelInfo is in the stock cache keeps
    // it verbatim (its tuned prompt, reasoning tiers, tool mode) — through
    // the gateway it still reaches the real Codex backend, so the stock
    // behavior is the correct behavior. This mirrors the gateway's own
    // picker merge. Only the transport hint is pinned to the gateway's HTTP.
    const stock = stockBySlug.get(id);
    if (stock !== undefined && isCodexNativeId(spec, id)) {
      return { ...stock, slug: id, visibility: "list", priority, prefer_websockets: false };
    }
    const model = models.find(
      (candidate) =>
        codexModelId(candidate.id) === id ||
        candidate.aliases?.some((alias) => codexModelId(alias) === id) === true
    );
    const levels = reasoningEffortDescriptors(model?.reasoning).map((effort) => ({
      effort: effort.id,
      description: effort.label
    }));
    return {
      ...neutralTemplate,
      prefer_websockets: false,
      slug: id,
      display_name: model?.label ?? id,
      description: "Gateway-routed model.",
      visibility: "list",
      priority,
      availability_nux: null,
      upgrade: null,
      // Codex requires this field on every catalog entry; an empty list means
      // "no discovered effort controls" without fabricating tiers.
      supported_reasoning_levels: levels,
      ...(model?.reasoning?.defaultEffort !== undefined
        ? { default_reasoning_level: model.reasoning.defaultEffort }
        : {}),
      supports_reasoning_summaries: model?.reasoning?.status === "supported"
    };
  });
  if (appendUnlistedStock) {
    for (const stock of stockModels) {
      const slug = presetSlug(stock);
      if (slug === undefined || listed.has(slug)) continue;
      listed.add(slug);
      entries.push({ ...stock, priority: entries.length });
    }
  }
  return entries;
}

export function codexModelCatalogJson(
  spec: Pick<ToolLaunchSpec, "defaultModel" | "models">,
  template: CodexModelPreset,
  stockModels: readonly CodexModelPreset[] = [],
  options: { appendUnlistedStock?: boolean } = {}
): string {
  return JSON.stringify(
    { models: codexCatalogEntries(spec, template, stockModels, options) },
    null,
    2
  );
}

export function codexProfileFileToml(model: string, provider: string = PROVIDER_ID): string {
  return `${tomlStringify({ model, model_provider: provider }).trimEnd()}\n`;
}

export function codexProfileFiles(
  home: string,
  models: readonly string[],
  provider: string = PROVIDER_ID
): string[] {
  const written: string[] = [];
  for (const model of models) {
    if (
      model.length === 0 ||
      model.includes("/") ||
      model.includes("\\") ||
      model.startsWith(".") ||
      written.includes(model)
    ) {
      continue;
    }
    writeFileSync(join(home, `${model}.config.toml`), codexProfileFileToml(model, provider));
    written.push(model);
  }
  return written;
}

export type CodexAgentRole = AgentProfile & { configPath: string };

export function codexAgentRoles(home: string, profiles: readonly AgentProfile[]): CodexAgentRole[] {
  return profiles.map((profile) => ({
    ...profile,
    configPath: join(home, PROFILE_DIR, `${profile.id}.toml`)
  }));
}

export function codexAgentRoleToml(profile: AgentProfile): string {
  return [
    `name = ${JSON.stringify(profile.id)}`,
    `model = ${JSON.stringify(codexModelId(profile.model))}`,
    `model_provider = ${JSON.stringify(PROVIDER_ID)}`,
    `developer_instructions = ${JSON.stringify(profile.instructions)}`,
    ""
  ].join("\n");
}

export function codexLaunchConfigToml(
  spec: Pick<ToolLaunchSpec, "gatewayUrl" | "defaultModel" | "reasoning" | "auth">,
  modelCatalogPath?: string,
  roles: readonly CodexAgentRole[] = []
): string {
  const lines = [
    `model = ${JSON.stringify(codexModelId(spec.defaultModel))}`,
    `model_provider = ${JSON.stringify(PROVIDER_ID)}`
  ];
  if (spec.reasoning?.mode === "effort") {
    lines.push(`model_reasoning_effort = ${JSON.stringify(spec.reasoning.effort)}`);
  }
  if (modelCatalogPath !== undefined) {
    lines.push(`model_catalog_json = ${JSON.stringify(modelCatalogPath)}`);
  }
  lines.push(
    "",
    `[model_providers.${PROVIDER_ID}]`,
    `name = "RouteKit gateway"`,
    `base_url = ${JSON.stringify(`${trimTrailingSlashes(spec.gatewayUrl)}/v1`)}`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    ...(spec.auth?.token !== undefined ? [`env_key = "ROUTEKIT_GATEWAY_TOKEN"`] : []),
    ""
  );
  if (roles.length > 0) {
    lines.push("[features]", "multi_agent = true", "", "[agents]", "max_depth = 1", "");
    for (const role of roles) {
      lines.push(
        `[agents.${tomlKey(role.id)}]`,
        `description = ${JSON.stringify(role.description)}`,
        `config_file = ${JSON.stringify(role.configPath)}`,
        ""
      );
    }
  }
  return lines.join("\n");
}

const CODEX_RESUME_CURSOR_VERSION = 1;
const MIN_MANAGED_CODEX_VERSION = [0, 146, 0] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGED_SESSION_ARGS = ["resume", "--last", "--remote"] as const;

export type CodexProcessResult = { code: number; stderr: string };
export type CodexLaunchDependencies = {
  spawnProcess?: typeof spawn;
  connectSocket?: (path: string) => Socket;
  env?: Record<string, string | undefined>;
};

export function codexResumeCursor(threadId: string): import("@velum-labs/routekit-harness-core").ResumeCursor {
  if (!UUID_PATTERN.test(threadId)) throw new Error(`invalid Codex thread id: ${threadId}`);
  return { version: CODEX_RESUME_CURSOR_VERSION, kind: "codex", data: { threadId } };
}

export function codexResumeThreadId(
  cursor: import("@velum-labs/routekit-harness-core").ResumeCursor
): string {
  if (cursor.version !== CODEX_RESUME_CURSOR_VERSION || cursor.kind !== "codex") {
    throw new Error("Codex resume requires a compatible codex cursor");
  }
  const data = cursor.data as { threadId?: unknown };
  if (typeof data.threadId !== "string" || !UUID_PATTERN.test(data.threadId)) {
    throw new Error("Codex resume cursor contains an invalid thread id");
  }
  return data.threadId;
}

export function resolveCodexHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env.CODEX_HOME;
  if (configured !== undefined && configured.length > 0) {
    if (!isAbsolute(configured)) throw new Error("CODEX_HOME must be an absolute path");
    return configured;
  }
  return join(env.HOME ?? env.USERPROFILE ?? homedir(), ".codex");
}

function tomlValue(value: string): string {
  return JSON.stringify(value);
}

function codexLaunchOverrides(
  spec: Pick<ToolLaunchSpec, "gatewayUrl" | "defaultModel" | "reasoning" | "auth">,
  catalogPath?: string,
  roles: readonly CodexAgentRole[] = []
): string[] {
  const values: Array<[string, string | boolean | number]> = [
    ["model", codexModelId(spec.defaultModel)],
    ["model_provider", PROVIDER_ID],
    [`model_providers.${PROVIDER_ID}.name`, "RouteKit gateway"],
    [`model_providers.${PROVIDER_ID}.base_url`, `${trimTrailingSlashes(spec.gatewayUrl)}/v1`],
    [`model_providers.${PROVIDER_ID}.wire_api`, "responses"],
    [`model_providers.${PROVIDER_ID}.requires_openai_auth`, false]
  ];
  if (spec.auth?.token !== undefined) values.push([`model_providers.${PROVIDER_ID}.env_key`, "ROUTEKIT_GATEWAY_TOKEN"]);
  if (spec.reasoning?.mode === "effort") values.push(["model_reasoning_effort", spec.reasoning.effort]);
  if (catalogPath !== undefined) values.push(["model_catalog_json", catalogPath]);
  if (roles.length > 0) {
    values.push(["features.multi_agent", true], ["agents.max_depth", 1]);
    for (const role of roles) {
      values.push(
        [`agents.${role.id}.description`, role.description],
        [`agents.${role.id}.config_file`, role.configPath]
      );
    }
  }
  return values.flatMap(([key, value]) => ["-c", `${key}=${typeof value === "string" ? tomlValue(value) : String(value)}`]);
}

function spawnCodex(
  args: readonly string[],
  home: string,
  cwd: string | undefined,
  token: string | undefined,
  spawnProcess: typeof spawn = spawn,
  stdio: ["inherit" | "ignore", "inherit" | "ignore" | "pipe", "pipe"] = ["inherit", "inherit", "pipe"]
): { child: ChildProcess; result: Promise<CodexProcessResult> } {
  const child = spawnProcess("codex", [...args], {
    stdio,
    env: {
      ...process.env,
      CODEX_HOME: home,
      ...(token !== undefined ? { ROUTEKIT_GATEWAY_TOKEN: token } : {})
    },
    ...(cwd !== undefined ? { cwd } : {})
  });
  const result = new Promise<CodexProcessResult>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stdio[0] === "inherit") process.stderr.write(chunk);
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve({ code: code ?? (signal === null ? 0 : 1), stderr })
    );
  });
  return { child, result };
}

function parseVersion(output: string): [number, number, number] | undefined {
  const match = output.match(/(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)/);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if ((actual[index] ?? 0) !== (minimum[index] ?? 0)) return (actual[index] ?? 0) > (minimum[index] ?? 0);
  }
  return true;
}

async function assertManagedCodexVersion(home: string, deps: CodexLaunchDependencies): Promise<void> {
  const probe = spawnCodex(["--version"], home, undefined, undefined, deps.spawnProcess, ["ignore", "pipe", "pipe"]);
  let stdout = "";
  probe.child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  const result = await probe.result;
  const version = parseVersion(`${stdout}\n${result.stderr}`);
  if (result.code !== 0 || version === undefined || !versionAtLeast(version, MIN_MANAGED_CODEX_VERSION)) {
    throw new Error(
      `managed Codex sessions require Codex CLI >=0.146.0 (found ${version?.join(".") ?? "an incompatible installation"}); run \`codex update\``
    );
  }
}

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WEBSOCKET_PAYLOAD = 4 * 1024 * 1024;

type Observer = {
  ready: Promise<void>;
  cursor: Promise<import("@velum-labs/routekit-harness-core").ResumeCursor>;
  close(): void;
};

function websocketAccept(key: string): string {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function websocketClientFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > MAX_WEBSOCKET_PAYLOAD) throw new Error("Codex WebSocket payload is too large");
  const extended = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extended + 4);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (extended === 0 ? payload.length : extended === 2 ? 126 : 127);
  if (extended === 2) header.writeUInt16BE(payload.length, 2);
  if (extended === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
  const maskOffset = 2 + extended;
  const mask = randomBytes(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, masked]);
}

type WebSocketFrame = { fin: boolean; opcode: number; payload: Buffer };

function parseWebSocketFrame(buffer: Buffer): { frame?: WebSocketFrame; rest: Buffer } {
  if (buffer.length < 2) return { rest: buffer };
  const first = buffer[0]!;
  const second = buffer[1]!;
  if ((first & 0x70) !== 0) throw new Error("Codex WebSocket used unsupported reserved bits");
  if ((second & 0x80) !== 0) throw new Error("Codex WebSocket server sent a masked frame");
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return { rest: buffer };
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return { rest: buffer };
    const large = buffer.readBigUInt64BE(2);
    if (large > BigInt(MAX_WEBSOCKET_PAYLOAD)) throw new Error("Codex WebSocket payload is too large");
    length = Number(large);
    offset = 10;
  }
  if (length > MAX_WEBSOCKET_PAYLOAD) throw new Error("Codex WebSocket payload is too large");
  const opcode = first & 0x0f;
  if (opcode >= 0x8 && ((first & 0x80) === 0 || length > 125)) {
    throw new Error("Codex WebSocket sent an invalid control frame");
  }
  if (buffer.length < offset + length) return { rest: buffer };
  return {
    frame: { fin: (first & 0x80) !== 0, opcode, payload: buffer.subarray(offset, offset + length) },
    rest: buffer.subarray(offset + length)
  };
}

function observeCodexAppServer(
  socketPath: string,
  connectSocket: (path: string) => Socket,
  onCursor: (cursor: import("@velum-labs/routekit-harness-core").ResumeCursor) => void | Promise<void>
): Observer {
  let socket: Socket | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let initialized = false;
  let readySettled = false;
  let cursorSettled = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let cursorResolve!: (cursor: import("@velum-labs/routekit-harness-core").ResumeCursor) => void;
  let cursorReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const cursor = new Promise<import("@velum-labs/routekit-harness-core").ResumeCursor>((resolve, reject) => { cursorResolve = resolve; cursorReject = reject; });
  cursor.catch(() => undefined);
  const failReady = (error: Error): void => {
    if (!readySettled) { readySettled = true; readyReject(error); }
  };
  const failCursor = (error: Error): void => {
    if (!cursorSettled) { cursorSettled = true; cursorReject(error); }
  };
  const fail = (error: Error, candidate?: Socket): void => {
    failReady(error);
    failCursor(error);
    candidate?.destroy();
  };
  const sendJson = (candidate: Socket, value: unknown): void => {
    candidate.write(websocketClientFrame(0x1, Buffer.from(JSON.stringify(value), "utf8")));
  };
  const handleMessage = (candidate: Socket, payload: Buffer): void => {
    let message: any;
    try { message = JSON.parse(payload.toString("utf8")); }
    catch { throw new Error("Codex WebSocket sent invalid JSON"); }
    if (message.id === 1) {
      if (message.error !== undefined) {
        throw new Error(`Codex app-server initialize failed: ${JSON.stringify(message.error)}`);
      }
      sendJson(candidate, { method: "initialized" });
      initialized = true;
      if (!readySettled) { readySettled = true; readyResolve(); }
    } else if (message.method === "thread/started") {
      const id = message.params?.thread?.id;
      if (typeof id !== "string") return;
      let value: import("@velum-labs/routekit-harness-core").ResumeCursor;
      try { value = codexResumeCursor(id); } catch { return; }
      if (cursorSettled) return;
      Promise.resolve(onCursor(value)).then(
        () => { if (!cursorSettled) { cursorSettled = true; cursorResolve(value); } },
        (error) => failCursor(error instanceof Error ? error : new Error(String(error)))
      );
    }
  };
  const attempt = (): void => {
    if (closed) return;
    const candidate = connectSocket(socketPath);
    let phase: "connecting" | "handshake" | "open" = "connecting";
    let handshakeBuffer: Buffer = Buffer.alloc(0);
    let frameBuffer: Buffer = Buffer.alloc(0);
    let fragmentedOpcode: number | undefined;
    let fragments: Buffer[] = [];
    let fragmentLength = 0;
    const key = randomBytes(16).toString("base64");
    candidate.once("connect", () => {
      if (closed) { candidate.destroy(); return; }
      socket = candidate;
      phase = "handshake";
      candidate.write([
        "GET / HTTP/1.1",
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n"));
    });
    candidate.on("data", (chunk: Buffer) => {
      if (closed) return;
      try {
        if (phase === "handshake") {
          handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
          if (handshakeBuffer.length > 16 * 1024) throw new Error("Codex WebSocket handshake headers are too large");
          const boundary = handshakeBuffer.indexOf("\r\n\r\n");
          if (boundary < 0) return;
          const header = handshakeBuffer.subarray(0, boundary).toString("latin1");
          const lines = header.split("\r\n");
          if (!/^HTTP\/1\.1 101(?:\s|$)/i.test(lines[0] ?? "")) {
            throw new Error(`Codex WebSocket upgrade failed: ${lines[0] ?? "invalid response"}`);
          }
          const headers = new Map<string, string>();
          for (const line of lines.slice(1)) {
            const colon = line.indexOf(":");
            if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
          }
          if (headers.get("upgrade")?.toLowerCase() !== "websocket" ||
              !headers.get("connection")?.toLowerCase().split(/\s*,\s*/).includes("upgrade") ||
              headers.get("sec-websocket-accept") !== websocketAccept(key)) {
            throw new Error("Codex WebSocket upgrade response is invalid");
          }
          phase = "open";
          frameBuffer = handshakeBuffer.subarray(boundary + 4);
          handshakeBuffer = Buffer.alloc(0);
          sendJson(candidate, { method: "initialize", id: 1, params: { clientInfo: { name: "routekit", title: "RouteKit", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } } });
        } else if (phase === "open") {
          frameBuffer = Buffer.concat([frameBuffer, chunk]);
        } else return;
        while (phase === "open") {
          const parsed = parseWebSocketFrame(frameBuffer);
          if (parsed.frame === undefined) break;
          frameBuffer = parsed.rest;
          const { fin, opcode, payload } = parsed.frame;
          if (opcode === 0x8) {
            if (!candidate.destroyed) candidate.write(websocketClientFrame(0x8, payload));
            candidate.end();
            failCursor(new Error("Codex app-server closed before a thread started"));
            return;
          }
          if (opcode === 0x9) { candidate.write(websocketClientFrame(0xa, payload)); continue; }
          if (opcode === 0xa) continue;
          if (opcode === 0x1) {
            if (fragmentedOpcode !== undefined) throw new Error("Codex WebSocket started a message during fragmentation");
            if (fin) handleMessage(candidate, payload);
            else { fragmentedOpcode = opcode; fragments = [payload]; fragmentLength = payload.length; }
            continue;
          }
          if (opcode === 0x0) {
            if (fragmentedOpcode === undefined) throw new Error("Codex WebSocket sent an unexpected continuation frame");
            fragmentLength += payload.length;
            if (fragmentLength > MAX_WEBSOCKET_PAYLOAD) throw new Error("Codex WebSocket fragmented payload is too large");
            fragments.push(payload);
            if (fin) {
              const complete = Buffer.concat(fragments, fragmentLength);
              fragmentedOpcode = undefined; fragments = []; fragmentLength = 0;
              handleMessage(candidate, complete);
            }
            continue;
          }
          throw new Error(`Codex WebSocket sent unsupported opcode ${opcode}`);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)), candidate);
      }
    });
    candidate.once("error", (error: NodeJS.ErrnoException) => {
      candidate.destroy();
      if (!closed && !initialized && phase === "connecting" && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
        retryTimer = setTimeout(attempt, 10);
      } else if (!closed) fail(error);
    });
    candidate.once("close", () => {
      if (socket === candidate) socket = undefined;
      if (!closed && phase !== "connecting") {
        if (!initialized) failReady(new Error("Codex app-server WebSocket closed before initialization"));
        failCursor(new Error("Codex app-server observer closed before a thread started"));
      }
    });
  };
  attempt();
  return {
    ready,
    cursor,
    close: () => {
      if (closed) return;
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (socket !== undefined && !socket.destroyed) {
        if (initialized) socket.write(websocketClientFrame(0x8, Buffer.from([0x03, 0xe8])));
        socket.end();
        socket.destroySoon();
      }
    }
  };
}

function hasManagedConflict(args: readonly string[]): string | undefined {
  return args.find((arg) => MANAGED_SESSION_ARGS.some((value) => arg === value || arg.startsWith(`${value}=`)));
}

export function codexManagedTuiArgs(spec: ToolLaunchSpec, endpoint: string, overrides: readonly string[]): string[] {
  const conflict = hasManagedConflict(spec.args);
  if (conflict !== undefined) throw new Error(`cannot forward ${conflict} when RouteKit is managing the Codex session`);
  const globals = ["--remote", endpoint, ...overrides];
  if (spec.session?.mode === "resume") return [...globals, "resume", codexResumeThreadId(spec.session.cursor), ...spec.args];
  return [...globals, ...spec.args];
}

async function launchManagedCodex(ctx: ToolLaunchContext, deps: CodexLaunchDependencies): Promise<ToolLaunchResult> {
  const { spec } = ctx;
  const home = resolveCodexHome(deps.env ?? process.env);
  await assertManagedCodexVersion(home, deps);
  // Unix-domain socket paths are short (roughly 104 bytes on macOS). Use a
  // private, per-launch OS temp directory rather than nesting under CODEX_HOME.
  const temp = mkdtempSync(join(tmpdir(), "rk-codex-"));
  const socketPath = join(temp, "server.sock");
  const endpoint = `unix://${socketPath}`;
  const stockModels = readCodexHomeModelsCache(home);
  const template = stockModels[0];
  const catalogPath = template === undefined ? undefined : join(temp, CATALOG_FILE);
  if (catalogPath !== undefined && template !== undefined) {
    writeFileSync(catalogPath, codexModelCatalogJson(spec, template, stockModels, { appendUnlistedStock: false }), { mode: 0o600 });
  }
  const roles = codexAgentRoles(temp, spec.agentProfiles ?? []);
  if (roles.length > 0) {
    mkdirSync(join(temp, PROFILE_DIR), { recursive: true, mode: 0o700 });
    for (const role of roles) writeFileSync(role.configPath, codexAgentRoleToml(role), { mode: 0o600 });
  }
  const overrides = codexLaunchOverrides(spec, catalogPath, roles);
  const server = spawnCodex(["app-server", "--listen", endpoint, ...overrides], home, spec.cwd, spec.auth?.token, deps.spawnProcess, ["ignore", "ignore", "pipe"]);
  const observer = observeCodexAppServer(socketPath, deps.connectSocket ?? ((path) => createConnection(path)), (cursor) => ctx.publishResumeCursor?.(cursor));
  ctx.registerDisposer(async () => {
    observer.close();
    if (server.child.exitCode === null) server.child.kill("SIGTERM");
    await Promise.race([server.result.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    rmSync(temp, { recursive: true, force: true });
  });
  await Promise.race([
    observer.ready,
    server.result.then((result) => { throw new Error(`Codex app-server exited before initialization (${result.code}): ${result.stderr.trim()}`); })
  ]);
  ctx.prepareForPassthrough();
  const tui = spawnCodex(codexManagedTuiArgs(spec, endpoint, overrides), home, spec.cwd, spec.auth?.token, deps.spawnProcess);
  const result = await tui.result;
  let resumeCursor = spec.session?.mode === "resume" ? spec.session.cursor : undefined;
  if (resumeCursor === undefined) {
    resumeCursor = await Promise.race([
      observer.cursor,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Codex exited before RouteKit observed thread/started; no session was enrolled")), 2_000)
      )
    ]);
  }
  return { exitCode: result.code, resumeCursor };
}

export async function launchCodex(ctx: ToolLaunchContext, deps: CodexLaunchDependencies = {}): Promise<ToolLaunchResult> {
  if (ctx.spec.session !== undefined) return await launchManagedCodex(ctx, deps);
  const home = resolveCodexHome(deps.env ?? process.env);
  const temp = mkdtempSync(join(tmpdir(), "rk-codex-"));
  ctx.registerDisposer(() => rmSync(temp, { recursive: true, force: true }));
  const stockModels = readCodexHomeModelsCache(home);
  const template = stockModels[0];
  const catalogPath = template === undefined ? undefined : join(temp, CATALOG_FILE);
  if (catalogPath !== undefined && template !== undefined) {
    writeFileSync(
      catalogPath,
      codexModelCatalogJson(ctx.spec, template, stockModels, { appendUnlistedStock: false }),
      { mode: 0o600 }
    );
  }
  const roles = codexAgentRoles(temp, ctx.spec.agentProfiles ?? []);
  if (roles.length > 0) {
    mkdirSync(join(temp, PROFILE_DIR), { recursive: true, mode: 0o700 });
    for (const role of roles) writeFileSync(role.configPath, codexAgentRoleToml(role), { mode: 0o600 });
  }
  const overrides = codexLaunchOverrides(ctx.spec, catalogPath, roles);
  ctx.prepareForPassthrough();
  const result = await spawnCodex([...overrides, ...ctx.spec.args], home, ctx.spec.cwd, ctx.spec.auth?.token, deps.spawnProcess).result;
  return { exitCode: result.code };
}

export async function removeCodexNativeSession(
  cursor: import("@velum-labs/routekit-harness-core").ResumeCursor,
  context: { env?: Record<string, string | undefined>; cwd?: string } = {},
  deps: CodexLaunchDependencies = {}
): Promise<void> {
  const threadId = codexResumeThreadId(cursor);
  const env = context.env ?? deps.env ?? process.env;
  const home = resolveCodexHome(env);
  const invocation = spawnCodex(["delete", threadId, "--force"], home, context.cwd, undefined, deps.spawnProcess, ["ignore", "ignore", "pipe"]);
  const result = await invocation.result;
  if (result.code !== 0) throw new Error(`Codex could not delete native session ${threadId}: ${result.stderr.trim() || `exit code ${result.code}`}`);
}
