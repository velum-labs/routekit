/*
 * Self-contained Linux helper streamed over SSH by t3-routekit-{deploy,destroy}.
 * It uses T3's native user systemd service and stores secrets only in a 0600
 * EnvironmentFile. It deliberately has no repository/runtime dependencies.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

const VERSION = 1;
const DEFAULT_ID = "default";
const DEFAULT_PORT = 3773;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SAFE_REMOTE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SAFE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TOKEN_ID = /^[a-f0-9]{16}$/i;
const OUTPUT_LIMIT = 16 * 1024 * 1024;

const processUid = process.getuid?.();
if (typeof processUid === "number") {
  process.env.XDG_RUNTIME_DIR ||= `/run/user/${processUid}`;
  process.env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=/run/user/${processUid}/bus`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeId(value, label = "deployment id") {
  if (typeof value !== "string" || !SAFE_ID.test(value))
    throw new Error(`${label} contains unsupported characters`);
  return value;
}

function parsePayload() {
  const encoded = process.argv.at(-1);
  if (typeof encoded !== "string" || encoded.length === 0)
    throw new Error("missing deployment payload");
  const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!isRecord(input) || !["deploy", "destroy"].includes(input.action))
    throw new Error("invalid deployment payload");
  if (input.serviceUser !== undefined && !SAFE_USER.test(input.serviceUser))
    throw new Error("invalid Linux service user");
  if (input.port !== undefined && input.port !== DEFAULT_PORT)
    throw new Error(`Linux T3 native service uses port ${DEFAULT_PORT}; omit --port`);
  return input;
}

function pathsFor(id) {
  const home = homedir();
  const routekitHome = process.env.ROUTEKIT_HOME?.trim() || join(home, ".routekit");
  const root = join(routekitHome, "t3", id);
  return {
    id,
    home,
    routekitHome,
    root,
    envPath: join(root, "t3.env"),
    manifestPath: join(routekitHome, "t3", "deployments", `${id}.linux.json`),
    t3Home: join(home, ".t3"),
    settingsPath: join(home, ".t3", "userdata", "settings.json"),
    unitPath: join(home, ".config", "systemd", "user", "t3code.service"),
    dropInDir: join(home, ".config", "systemd", "user", "t3code.service.d"),
    dropInPath: join(home, ".config", "systemd", "user", "t3code.service.d", "routekit.conf"),
    lingerShimDir: join(root, ".install-bin"),
    lingerShimPath: join(root, ".install-bin", "loginctl"),
    codexConfigPath: join(home, ".codex", "config.toml"),
    codexProfilePath: join(home, ".codex", "routekit.config.toml"),
    codexCatalogPath: join(home, ".codex", ".routekit-model-catalog.json"),
    claudeConfigPath: join(home, ".claude", "settings.json"),
    claudeOwnershipPath: join(home, ".claude", ".routekit-integration.json"),
    nativeRegistryPath: join(routekitHome, "integrations", "native-clients.json")
  };
}

function requireRegular(path, label) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return entry;
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function jsonFile(path, label) {
  try {
    return JSON.parse(readText(path));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function ensurePrivateDirectory(path) {
  if (existsSync(path)) {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(`refusing non-directory or symlinked path: ${path}`);
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  chmodSync(path, 0o700);
}

function writePrivateAtomic(path, content) {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function assertPrivateFile(path, expectedHash, label, allowMissing = false) {
  if (!existsSync(path)) {
    if (allowMissing) return false;
    throw new Error(`${label} is missing`);
  }
  const entry = requireRegular(path, label);
  if (entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o600)
    throw new Error(`${label} must be owned by the service user with mode 0600`);
  if (sha256(readText(path)) !== expectedHash) throw new Error(`${label} was modified`);
  return true;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env, HOME: homedir() },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) child.kill("SIGKILL");
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      })
    );
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

async function mustRun(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${basename(command)} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

async function commandPath(command) {
  const output = await mustRun("/usr/bin/which", [command]);
  const path = output.trim();
  if (!isAbsolute(path)) throw new Error(`${command} did not resolve to an absolute path`);
  return path;
}

function targetArgs(target) {
  if (target.kind === "local") return ["--local"];
  if (target.kind === "remote" && SAFE_REMOTE.test(target.name)) return ["--remote", target.name];
  throw new Error("invalid RouteKit target");
}

function allowedRoutekit(args) {
  const command = [...args];
  while (["--local", "--json", "--remote"].includes(command[0])) {
    if (command[0] === "--remote") command.splice(0, 2);
    else command.shift();
  }
  if (
    ["status", "models list", "remote list"].includes(command.join(" "))
  )
    return true;
  if (
    ["codex install --no-token", "claude install --no-token", "token list"].includes(
      command.join(" ")
    )
  )
    return true;
  if (
    command.length === 7 &&
    command[0] === "token" &&
    command[1] === "issue" &&
    command[3] === "--plane" &&
    command[4] === "data" &&
    command[5] === "--created-by" &&
    /^t3-routekit-linux-[a-z0-9._-]+-[a-f0-9]{24}-(codex|claude)$/i.test(command[2])
  )
    return true;
  return (
    command.length === 3 &&
    command[0] === "token" &&
    command[1] === "revoke" &&
    TOKEN_ID.test(command[2])
  );
}

async function routekit(target, args) {
  const invocation = [...targetArgs(target), ...args];
  if (!allowedRoutekit(invocation))
    throw new Error(
      `refusing non-allowlisted RouteKit operation: routekit ${invocation.join(" ")}`
    );
  return await mustRun("routekit", invocation);
}

async function routekitJson(target, args) {
  const output = await routekit(target, ["--json", ...args]);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("RouteKit returned invalid JSON");
  }
}

async function gatewayForTarget(target, status) {
  if (target.kind === "local") return normalizedGatewayUrl(status.daemon.dataUrl);
  const listed = await routekitJson(target, ["remote", "list"]);
  const remote = Array.isArray(listed.remotes)
    ? listed.remotes.find((entry) => isRecord(entry) && entry.name === target.name)
    : undefined;
  if (typeof remote?.gatewayUrl !== "string")
    throw new Error(`RouteKit remote ${target.name} has no gateway URL`);
  return normalizedGatewayUrl(remote.gatewayUrl);
}

function integrationTargetEquals(entry, target) {
  if (!isRecord(entry) || !isRecord(entry.target)) return false;
  if (target.kind === "local") return entry.target.kind === "local";
  return entry.target.kind === "remote" && entry.target.name === target.name;
}

function normalizedGatewayUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid RouteKit gateway URL");
  return url.toString().replace(/\/$/, "");
}

function noTokenIntegrationMatches(paths, tool, gateway) {
  const expectedGateway = normalizedGatewayUrl(gateway);
  if (tool === "codex") {
    const match = readText(paths.codexConfigPath).match(
      /^base_url\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m
    );
    if (match?.[1] === undefined) return false;
    return normalizedGatewayUrl(JSON.parse(match[1])) === `${expectedGateway}/v1`;
  }
  const ownership = jsonFile(paths.claudeOwnershipPath, "Claude RouteKit ownership");
  const settingsGateway = jsonFile(paths.claudeConfigPath, "Claude settings")?.env
    ?.ANTHROPIC_BASE_URL;
  return (
    ownership?.state === "installed" &&
    ownership?.ownerId === "routekit" &&
    typeof ownership?.managedEnvValues?.ANTHROPIC_BASE_URL === "string" &&
    typeof settingsGateway === "string" &&
    normalizedGatewayUrl(ownership.managedEnvValues.ANTHROPIC_BASE_URL) === expectedGateway &&
    normalizedGatewayUrl(settingsGateway) === expectedGateway
  );
}

function integrationPresent(paths, target, tool, gateway) {
  const configPath = tool === "codex" ? paths.codexConfigPath : paths.claudeConfigPath;
  const artifacts =
    tool === "codex"
      ? [paths.codexProfilePath, paths.codexCatalogPath]
      : [paths.claudeOwnershipPath];
  if (existsSync(configPath)) requireRegular(configPath, `${tool} configuration`);
  for (const artifact of artifacts) {
    if (existsSync(artifact)) requireRegular(artifact, `RouteKit ${tool} ownership artifact`);
  }
  if (existsSync(paths.nativeRegistryPath))
    requireRegular(paths.nativeRegistryPath, "native integration registry");
  const block =
    existsSync(configPath) &&
    (tool === "codex"
      ? readText(configPath).includes("# >>> routekit integration >>>")
      : Boolean(jsonFile(configPath, "Claude settings")?.env?.ANTHROPIC_BASE_URL));
  const registry = existsSync(paths.nativeRegistryPath)
    ? jsonFile(paths.nativeRegistryPath, "native integration registry")
    : { version: 1, integrations: [] };
  if (registry.version !== 1 || !Array.isArray(registry.integrations))
    throw new Error("native integration registry has an unsupported format");
  const entry = registry.integrations.find(
    (candidate) =>
      isRecord(candidate) && candidate.tool === tool && candidate.configPath === configPath
  );
  const completeArtifacts = artifacts.every((path) => existsSync(path));
  const anyArtifacts = artifacts.some((path) => existsSync(path));
  if (entry !== undefined) {
    if (!block || !completeArtifacts)
      throw new Error(`found a partial RouteKit ${tool} integration; refusing to alter it`);
    if (!integrationTargetEquals(entry, target))
      throw new Error(`existing RouteKit ${tool} integration targets another gateway`);
    return true;
  }
  if (!block && !anyArtifacts) return false;
  if (!block || !completeArtifacts)
    throw new Error(`found untracked RouteKit ${tool} ownership files; refusing to alter them`);
  if (!noTokenIntegrationMatches(paths, tool, gateway))
    throw new Error(`existing RouteKit ${tool} integration targets another gateway`);
  return true;
}

function parseCodexProfile(paths) {
  requireRegular(paths.codexProfilePath, "RouteKit Codex profile");
  const content = readText(paths.codexProfilePath);
  const value = (key) => {
    const match = content.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"));
    if (match?.[1] === undefined) throw new Error(`RouteKit Codex profile is missing ${key}`);
    return JSON.parse(match[1]);
  };
  const model = value("model");
  const provider = value("model_provider");
  const catalog = value("model_catalog_json");
  if (provider !== "routekit" || !isAbsolute(catalog))
    throw new Error("RouteKit Codex profile is invalid");
  requireRegular(catalog, "RouteKit Codex catalog");
  return `-c model=${JSON.stringify(model)} -c model_provider=${JSON.stringify(provider)} -c model_catalog_json=${JSON.stringify(catalog)}`;
}

function claudeGateway(paths) {
  const value = jsonFile(paths.claudeConfigPath, "Claude settings")?.env?.ANTHROPIC_BASE_URL;
  if (typeof value !== "string") throw new Error("Claude RouteKit gateway is missing");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Claude gateway URL is invalid");
  return url.toString().replace(/\/$/, "");
}

function systemdEnvironment(values) {
  return `${Object.entries(values)
    .map(([key, value]) => {
      if (typeof value !== "string" || /[\r\n\0]/.test(value))
        throw new Error(`invalid ${key} value`);
      return `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    })
    .join("\n")}\n`;
}

function settingsContent(codexPath, claudePath, launchArgs, models) {
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.some((model) => typeof model !== "string")
  )
    throw new Error("RouteKit returned no usable models");
  return `${JSON.stringify(
    {
      providerInstances: {
        codex: {
          driver: "codex",
          displayName: "Codex via RouteKit",
          enabled: true,
          config: { binaryPath: codexPath, launchArgs, customModels: models }
        },
        claudeAgent: {
          driver: "claudeAgent",
          displayName: "Claude via RouteKit",
          enabled: true,
          config: {
            binaryPath: claudePath,
            customModels: models.map((model) => `anthropic.routekit.${model}`)
          }
        }
      }
    },
    null,
    2
  )}\n`;
}

function dropInContent(envPath) {
  if (!isAbsolute(envPath) || /[\r\n]/.test(envPath)) throw new Error("invalid environment path");
  return `[Service]\nEnvironmentFile=${envPath}\n`;
}

function tokenRecord(id, nonce, tool) {
  return {
    id: "0000000000000000",
    label: `t3-routekit-linux-${id}-${nonce}-${tool}`,
    createdBy: `t3-routekit-linux:${id}:${nonce}:${tool}`,
    tokenSha256: "0".repeat(64)
  };
}

function validateManifest(manifest, paths) {
  if (!isRecord(manifest) || manifest.version !== VERSION || manifest.id !== paths.id)
    throw new Error("Linux deployment manifest has an unsupported format");
  if (!["deploying", "active", "destroying"].includes(manifest.state))
    throw new Error("Linux deployment manifest has an invalid state");
  if (
    manifest.home !== paths.home ||
    manifest.envPath !== paths.envPath ||
    manifest.dropInPath !== paths.dropInPath
  )
    throw new Error("Linux deployment manifest path mismatch");
  if (!isRecord(manifest.assets) || !isRecord(manifest.tokens))
    throw new Error("Linux deployment manifest is incomplete");
  return manifest;
}

function readManifest(paths) {
  if (!existsSync(paths.manifestPath)) return undefined;
  requireRegular(paths.manifestPath, "Linux deployment manifest");
  return validateManifest(jsonFile(paths.manifestPath, "Linux deployment manifest"), paths);
}

function saveManifest(paths, manifest) {
  validateManifest(manifest, paths);
  writePrivateAtomic(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function listTokens(target) {
  const result = await routekitJson(target, ["token", "list"]);
  if (!Array.isArray(result.tokens)) throw new Error("RouteKit token list is invalid");
  return result.tokens;
}

function matchingToken(tokens, record) {
  const token = tokens.find(
    (entry) =>
      isRecord(entry) &&
      entry.id === record.id &&
      entry.label === record.label &&
      entry.createdBy === record.createdBy &&
      entry.plane === "data" &&
      entry.role === "admin"
  );
  if (token === undefined)
    throw new Error(`RouteKit token ${record.id} no longer matches this deployment`);
  return token;
}

async function issueToken(paths, manifest, target, tool) {
  const record = manifest.tokens[tool];
  const issued = await routekitJson(target, [
    "token",
    "issue",
    record.label,
    "--plane",
    "data",
    "--created-by",
    record.createdBy
  ]);
  if (
    !TOKEN_ID.test(String(issued.id)) ||
    typeof issued.token !== "string" ||
    issued.token.length === 0
  )
    throw new Error("RouteKit returned an invalid service token");
  record.id = issued.id;
  record.tokenSha256 = sha256(issued.token);
  saveManifest(paths, manifest);
  return issued.token;
}

async function revokeTokens(manifest, target) {
  const listed = await listTokens(target);
  for (const tool of ["codex", "claude"]) {
    const record = manifest.tokens[tool];
    if (record.id === "0000000000000000") continue;
    const entry = matchingToken(listed, record);
    if (entry.revokedAt === undefined) await routekitJson(target, ["token", "revoke", record.id]);
  }
}

async function waitForHealth() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("T3 did not become healthy on loopback");
}

async function verifyCredential(gateway, token) {
  const response = await fetch(`${gateway}/v1/models`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`gateway credential returned HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.data) || body.data.length === 0)
    throw new Error("gateway returned no models");
}

async function installNativeService(paths, t3Path, serviceUser) {
  ensurePrivateDirectory(paths.lingerShimDir);
  const shim = `#!/bin/sh
set -eu
[ "$#" -eq 1 ] && [ "$1" = "enable-linger" ] || exit 64
[ "$(/usr/bin/loginctl show-user ${serviceUser} --property=Linger --value)" = "yes" ]
`;
  writePrivateAtomic(paths.lingerShimPath, shim);
  chmodSync(paths.lingerShimPath, 0o700);
  try {
    await mustRun(t3Path, ["service", "install"], {
      env: { PATH: `${paths.lingerShimDir}:${process.env.PATH ?? ""}` }
    });
  } finally {
    if (existsSync(paths.lingerShimPath)) unlinkSync(paths.lingerShimPath);
    try {
      rmdirSync(paths.lingerShimDir);
    } catch {}
  }
}

async function rollback(paths, manifest) {
  try {
    await mustRun("systemctl", ["--user", "disable", "--now", "t3code.service"]);
  } catch {}
  if (manifest.unitOwnership === "created" && existsSync(paths.unitPath)) {
    try {
      await mustRun("t3", ["service", "uninstall"]);
    } catch {}
  }
  for (const [path, key] of [
    [paths.dropInPath, "dropIn"],
    [paths.settingsPath, "settings"],
    [paths.envPath, "environment"]
  ]) {
    const expected = manifest.assets[key];
    if (
      typeof expected === "string" &&
      !/^0+$/.test(expected) &&
      existsSync(path) &&
      sha256(readText(path)) === expected
    )
      unlinkSync(path);
  }
  if (existsSync(paths.lingerShimPath)) unlinkSync(paths.lingerShimPath);
  try {
    rmdirSync(paths.lingerShimDir);
  } catch {}
  try {
    await revokeTokens(manifest, manifest.topology);
  } catch {}
  try {
    rmdirSync(paths.dropInDir);
  } catch {}
  try {
    rmdirSync(paths.root);
  } catch {}
}

async function deploy(input) {
  const id = safeId(input.deploymentId ?? DEFAULT_ID);
  const paths = pathsFor(id);
  const target = input.routekit;
  targetArgs(target);
  const wantedVersion = input.t3Version;
  if (typeof wantedVersion !== "string" || !SAFE_VERSION.test(wantedVersion))
    throw new Error("T3 version must be exact semver");
  const currentUser = (await mustRun("/usr/bin/id", ["-un"])).trim();
  if (!SAFE_USER.test(currentUser) || currentUser === "root")
    throw new Error("Linux deployment must run as a non-root service user");
  if (input.serviceUser !== undefined && input.serviceUser !== currentUser)
    throw new Error("Linux helper is not running as --service-user");
  for (const [path, label] of [
    [paths.routekitHome, "RouteKit home"],
    [paths.t3Home, "T3 home"],
    [join(paths.home, ".config"), "user config home"]
  ]) {
    if (!existsSync(path)) continue;
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(`refusing non-directory or symlinked ${label}`);
  }
  const existing = readManifest(paths);
  if (existing?.state === "active") {
    for (const [path, key, label] of [
      [paths.envPath, "environment", "RouteKit environment"],
      [paths.dropInPath, "dropIn", "systemd drop-in"],
      [paths.settingsPath, "settings", "T3 settings"]
    ])
      assertPrivateFile(path, existing.assets[key], label);
    if (
      existing.unitOwnership === "created" &&
      sha256(readText(paths.unitPath)) !== existing.assets.unit
    )
      throw new Error("manifest-owned T3 systemd unit was modified");
    const listed = await listTokens(existing.topology);
    for (const tool of ["codex", "claude"]) matchingToken(listed, existing.tokens[tool]);
    await waitForHealth();
    return {
      ok: true,
      action: "verified-existing",
      deploymentId: id,
      port: DEFAULT_PORT,
      serviceMode: "systemd-user"
    };
  }
  if (existing?.state === "deploying") {
    if (input.dryRun) return { ok: true, action: "would-recover-interrupted", deploymentId: id };
    await rollback(paths, existing);
    if (existsSync(paths.manifestPath)) unlinkSync(paths.manifestPath);
  }
  if (existing?.state === "destroying")
    throw new Error("rerun t3:destroy for the incomplete destroy");
  if (existsSync(paths.root) || existsSync(paths.dropInPath) || existsSync(paths.settingsPath))
    throw new Error("refusing pre-existing Linux T3 deployment assets without an active manifest");

  const status = await routekitJson(target, ["status"]);
  if (
    status?.daemon?.healthy === false ||
    typeof status?.daemon?.dataUrl !== "string" ||
    !(status?.models?.count > 0)
  )
    throw new Error("selected RouteKit gateway is not healthy and model-ready");
  const gateway = await gatewayForTarget(target, status);
  const integrations = {
    codex: integrationPresent(paths, target, "codex", gateway),
    claude: integrationPresent(paths, target, "claude", gateway)
  };
  const t3Path = await commandPath("t3");
  const codexPath = await commandPath("codex");
  const claudePath = await commandPath("claude");
  const installedVersion = (await mustRun(t3Path, ["--version"])).match(/\d+\.\d+\.\d+/)?.[0];
  if (installedVersion !== wantedVersion)
    throw new Error(`installed T3 ${installedVersion ?? "unknown"}, expected ${wantedVersion}`);
  await Promise.all([mustRun(codexPath, ["--version"]), mustRun(claudePath, ["--version"])]);
  if (input.dryRun) {
    return {
      ok: true,
      action: "would-deploy",
      deploymentId: id,
      port: DEFAULT_PORT,
      serviceMode: "systemd-user",
      targetUser: currentUser,
      routekit: target,
      preserves: ["normal ~/.t3, ~/.codex, ~/.claude, Git, and project state"]
    };
  }

  const unitExisted = existsSync(paths.unitPath);
  const nonce = randomBytes(12).toString("hex");
  const manifest = {
    version: VERSION,
    state: "deploying",
    id,
    home: paths.home,
    serviceUser: currentUser,
    port: DEFAULT_PORT,
    t3Version: wantedVersion,
    topology: target,
    envPath: paths.envPath,
    dropInPath: paths.dropInPath,
    unitPath: paths.unitPath,
    unitOwnership: unitExisted ? "existing" : "created",
    nonce,
    tokens: { codex: tokenRecord(id, nonce, "codex"), claude: tokenRecord(id, nonce, "claude") },
    integrations: {
      codex: { ownership: integrations.codex ? "existing" : "created" },
      claude: { ownership: integrations.claude ? "existing" : "created" }
    },
    assets: {
      environment: "0".repeat(64),
      dropIn: "0".repeat(64),
      settings: "0".repeat(64),
      unit: "0".repeat(64)
    },
    createdAt: new Date().toISOString()
  };
  ensurePrivateDirectory(paths.root);
  saveManifest(paths, manifest);

  try {
    if (!integrations.codex) await routekit(target, ["codex", "install", "--no-token"]);
    if (!integrations.claude) await routekit(target, ["claude", "install", "--no-token"]);
    const launchArgs = parseCodexProfile(paths);
    const claudeBaseUrl = claudeGateway(paths);
    const catalog = await routekitJson(target, ["models", "list"]);
    const settings = settingsContent(codexPath, claudePath, launchArgs, catalog.models);
    const codexToken = await issueToken(paths, manifest, target, "codex");
    const claudeToken = await issueToken(paths, manifest, target, "claude");
    const environment = systemdEnvironment({
      ROUTEKIT_GATEWAY_TOKEN: codexToken,
      ANTHROPIC_AUTH_TOKEN: claudeToken,
      ANTHROPIC_BASE_URL: claudeBaseUrl,
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
      T3CODE_CODEX_LAUNCH_ARGS: launchArgs
    });
    const dropIn = dropInContent(paths.envPath);
    manifest.assets.environment = sha256(environment);
    manifest.assets.settings = sha256(settings);
    manifest.assets.dropIn = sha256(dropIn);
    saveManifest(paths, manifest);
    writePrivateAtomic(paths.envPath, environment);
    writePrivateAtomic(paths.settingsPath, settings);
    await installNativeService(paths, t3Path, currentUser);
    if (!existsSync(paths.unitPath))
      throw new Error("T3 native service did not create its systemd unit");
    writePrivateAtomic(paths.dropInPath, dropIn);
    manifest.assets.unit = sha256(readText(paths.unitPath));
    saveManifest(paths, manifest);
    await mustRun("systemctl", ["--user", "daemon-reload"]);
    await mustRun("systemctl", ["--user", "restart", "t3code.service"]);
    await waitForHealth();
    await Promise.all([
      verifyCredential(gateway, codexToken),
      verifyCredential(gateway, claudeToken)
    ]);
    await mustRun("tailscale", ["serve", "--bg", "--https=443", `127.0.0.1:${DEFAULT_PORT}`]);
    for (const project of [...new Set(input.projects ?? [])]) {
      if (!isAbsolute(project)) throw new Error(`T3 project must be absolute: ${project}`);
      const result = await run(t3Path, ["project", "add", "--base-dir", paths.t3Home, project]);
      if (result.code !== 0 && !/already exists/i.test(`${result.stdout}\n${result.stderr}`))
        throw new Error(`could not add T3 project ${project}`);
    }
    manifest.state = "active";
    manifest.verifiedAt = new Date().toISOString();
    saveManifest(paths, manifest);
    return {
      ok: true,
      action: "deployed",
      deploymentId: id,
      port: DEFAULT_PORT,
      serviceMode: "systemd-user",
      targetUser: currentUser,
      routekit: target,
      verified: ["T3 health", "Codex deployment token", "Claude deployment token"]
    };
  } catch (error) {
    await rollback(paths, manifest);
    throw error;
  }
}

async function destroy(input) {
  const id = safeId(input.deploymentId ?? DEFAULT_ID);
  const paths = pathsFor(id);
  const manifest = readManifest(paths);
  if (manifest === undefined) return { ok: true, action: "nothing-to-destroy", deploymentId: id };
  if (input.serviceUser !== undefined && input.serviceUser !== manifest.serviceUser)
    throw new Error("manifest belongs to another Linux service user");
  if (input.dryRun)
    return {
      ok: true,
      action: "would-destroy",
      deploymentId: id,
      preserves: [
        "T3 chats and state",
        "Codex and Claude configuration",
        "Git and projects",
        "global packages"
      ]
    };
  if (manifest.state === "deploying") {
    await rollback(paths, manifest);
    if (existsSync(paths.manifestPath)) unlinkSync(paths.manifestPath);
    return {
      ok: true,
      action: "recovered-interrupted-deployment",
      deploymentId: id,
      preserved: [
        "T3 chats and state",
        "Codex and Claude configuration",
        "Git and projects",
        "global packages"
      ]
    };
  }
  for (const [path, key, label] of [
    [paths.envPath, "environment", "RouteKit environment"],
    [paths.dropInPath, "dropIn", "systemd drop-in"],
    [paths.settingsPath, "settings", "T3 settings"]
  ])
    assertPrivateFile(path, manifest.assets[key], label, manifest.state === "destroying");
  if (manifest.unitOwnership === "created" && existsSync(paths.unitPath)) {
    if (sha256(readText(paths.unitPath)) !== manifest.assets.unit)
      throw new Error("manifest-owned T3 systemd unit was modified; refusing destruction");
  } else if (manifest.unitOwnership === "created" && manifest.state !== "destroying") {
    throw new Error("manifest-owned T3 systemd unit is missing; refusing destruction");
  }
  if (existsSync(paths.envPath)) {
    const environment = readText(paths.envPath);
    for (const tool of ["codex", "claude"]) {
      const key = tool === "codex" ? "ROUTEKIT_GATEWAY_TOKEN" : "ANTHROPIC_AUTH_TOKEN";
      const match = environment.match(new RegExp(`^${key}="((?:[^"\\\\]|\\\\.)*)"$`, "m"));
      if (match === null) throw new Error(`deployment environment is missing ${key}`);
      const token = match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\");
      if (sha256(token) !== manifest.tokens[tool].tokenSha256)
        throw new Error(`deployment ${tool} credential was modified`);
    }
  }
  const listed = await listTokens(manifest.topology);
  for (const tool of ["codex", "claude"]) matchingToken(listed, manifest.tokens[tool]);
  manifest.state = "destroying";
  saveManifest(paths, manifest);
  const serveOff = await run("tailscale", ["serve", "--https=443", "off"]);
  if (serveOff.code !== 0 && !/not configured|no serve config|already off/i.test(serveOff.stderr))
    throw new Error(`could not remove Tailscale Serve mapping: ${serveOff.stderr.trim()}`);
  if (manifest.unitOwnership === "created") await mustRun("t3", ["service", "uninstall"]);
  await revokeTokens(manifest, manifest.topology);
  for (const path of [paths.dropInPath, paths.settingsPath, paths.envPath]) {
    if (existsSync(path)) unlinkSync(path);
  }
  if (manifest.unitOwnership === "existing" && existsSync(paths.unitPath)) {
    await mustRun("systemctl", ["--user", "daemon-reload"]);
    await mustRun("systemctl", ["--user", "restart", "t3code.service"]);
  }
  try {
    rmdirSync(paths.dropInDir);
  } catch {}
  try {
    rmdirSync(paths.root);
  } catch {}
  unlinkSync(paths.manifestPath);
  try {
    rmdirSync(dirname(paths.manifestPath));
  } catch {}
  return {
    ok: true,
    action: "destroyed",
    deploymentId: id,
    removed: [
      "manifest-owned systemd assets",
      "RouteKit environment",
      "T3 provider settings",
      "deployment tokens"
    ],
    preserved: [
      "T3 chats and state",
      "Codex and Claude configuration",
      "Git and projects",
      "global packages"
    ]
  };
}

async function main() {
  if (process.platform !== "linux") throw new Error("Linux helper received a non-Linux target");
  const input = parsePayload();
  const result = input.action === "deploy" ? await deploy(input) : await destroy(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
  );
  process.exitCode = 0;
});
