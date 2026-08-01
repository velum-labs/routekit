/*
 * This program is streamed over SSH by t3-routekit-{deploy,destroy}.mjs.  It
 * deliberately depends only on Node built-ins: the target needs Node for T3,
 * but does not need a checkout of RouteKit.  It prints exactly one JSON result
 * and never includes a plaintext credential in that result.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const DEPLOYMENT_VERSION = 4;
const LEGACY_DEPLOYMENT_VERSION = 3;
const DEFAULT_DEPLOYMENT_ID = "default";
const KEYCHAIN_SERVICE = "routekit-t3";
const ROUTEKIT_OWNER = "routekit";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SAFE_REMOTE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TOKEN_ID = /^[a-f0-9]{16}$/i;
const OUTPUT_LIMIT = 16 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(
      `${label} must start with a letter or number and contain only letters, numbers, ., _, or -`
    );
  }
  return value;
}

function safeRemote(value) {
  return safeId(value, "RouteKit remote name");
}

function safePort(value) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("port must be an integer from 1024 through 65535");
  }
  return value;
}

function exactVersion(value) {
  if (typeof value !== "string" || !SAFE_VERSION.test(value)) {
    throw new Error("T3 version must be an exact semver release");
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload() {
  const encoded = process.argv.at(-1);
  if (typeof encoded !== "string" || encoded.length === 0)
    throw new Error("missing deployment payload");
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!isRecord(parsed) || (parsed.action !== "deploy" && parsed.action !== "destroy")) {
    throw new Error("invalid deployment payload");
  }
  return parsed;
}

function deploymentNames(id) {
  safeId(id, "deployment id");
  const stem = `t3-routekit-${id}`;
  return {
    id,
    label: `com.velum.routekit.t3.${id}`
  };
}

function homePaths(id) {
  const home = homedir();
  const routekitHome = process.env.ROUTEKIT_HOME?.trim() || join(home, ".routekit");
  const root = join(routekitHome, "t3", id);
  const names = deploymentNames(id);
  return {
    home,
    routekitHome,
    root,
    t3Home: join(home, ".t3"),
    logDir: join(root, "logs"),
    wrapperPath: join(root, "run-t3.sh"),
    stdoutPath: join(root, "logs", "t3.stdout.log"),
    stderrPath: join(root, "logs", "t3.stderr.log"),
    t3SettingsPath: join(home, ".t3", "userdata", "settings.json"),
    manifestPath: join(routekitHome, "t3", "deployments", `${id}.json`),
    plistPath: join(home, "Library", "LaunchAgents", `${names.label}.plist`),
    codexConfigPath: join(home, ".codex", "config.toml"),
    codexProfilePath: join(home, ".codex", "routekit.config.toml"),
    codexCatalogPath: join(home, ".codex", ".routekit-model-catalog.json"),
    claudeConfigPath: join(home, ".claude", "settings.json"),
    claudeOwnershipPath: join(home, ".claude", ".routekit-integration.json"),
    nativeRegistryPath: join(routekitHome, "integrations", "native-clients.json"),
    routerConfigPath: join(home, ".config", "routekit", "router.yaml"),
    remotesPath: join(routekitHome, "remotes.json"),
    ...names
  };
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function snapshot(path) {
  if (!existsSync(path)) return null;
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`refusing non-regular file: ${path}`);
  }
  return readFileSync(path);
}

function sameSnapshot(path, before, label) {
  const after = snapshot(path);
  const equal =
    (before === null && after === null) ||
    (before !== null && after !== null && Buffer.compare(before, after) === 0);
  if (!equal) throw new Error(`${label} changed during deployment; refusing to continue`);
}

function writePrivateAtomic(path, content) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function writeNewOwnedFile(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const entry = existsSync(path) ? lstatSync(path) : undefined;
  if (entry !== undefined) {
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error(`refusing non-regular owned asset: ${path}`);
    if (readText(path) !== content)
      throw new Error(`refusing to overwrite an existing asset: ${path}`);
    return false;
  }
  writeFileSync(path, content, { mode, flag: "wx" });
  chmodSync(path, mode);
  return true;
}

function writeManagedT3Settings(paths, content) {
  if (existsSync(paths.t3SettingsPath))
    requireRegular(paths.t3SettingsPath, "T3 settings to manage");
  writePrivateAtomic(paths.t3SettingsPath, content);
}

function requireRegular(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error(`${label} is not a regular file: ${path}`);
  return entry;
}

async function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 90_000;
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const collect = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) {
        child.kill("SIGTERM");
        finish(() => rejectRun(new Error(`${command} produced too much output`)));
        return;
      }
      target.push(chunk);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => rejectRun(new Error(`${command} timed out`)));
    }, timeoutMs);
    child.once("error", (error) => finish(() => rejectRun(error)));
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("close", (code, signal) =>
      finish(() =>
        resolveRun({
          code: code ?? 1,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        })
      )
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

async function mustRun(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

async function commandPath(command, options = {}) {
  const output = await mustRun("/usr/bin/which", [command]);
  const path = output.trim();
  if (!isAbsolute(path))
    throw new Error(`${command} did not resolve to an absolute executable path`);
  return options.resolveSymlink === false ? path : realpathSync(path);
}

function jsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function targetArgs(target) {
  if (target.kind === "local") return ["--local"];
  if (target.kind === "remote") return ["--remote", safeRemote(target.name)];
  throw new Error("invalid RouteKit target");
}

function routekitCommandArgs(argv) {
  const command = [...argv];
  while (command[0] === "--local" || command[0] === "--json" || command[0] === "--remote") {
    if (command[0] === "--remote") {
      if (typeof command[1] !== "string") return undefined;
      safeRemote(command[1]);
      command.splice(0, 2);
      continue;
    }
    command.shift();
  }
  return command;
}

function isDeploymentTokenPair(label, createdBy) {
  const match = /^t3-routekit-([a-z0-9][a-z0-9._-]{0,63})-([a-f0-9]{24})-(codex|claude)$/i.exec(
    label
  );
  return match !== null && createdBy === `t3-routekit:${match[1]}:${match[2]}:${match[3]}`;
}

/**
 * This is an allow-list, not a deny-list.  The streamed helper must never
 * gain a RouteKit configuration, account, remote, daemon, or native-uninstall
 * operation merely because a future RouteKit subcommand was added.
 */
function assertAllowedRoutekit(args) {
  const command = routekitCommandArgs(args);
  if (command === undefined) throw new Error("RouteKit invocation has an invalid target");
  const allowed =
    (command.length === 1 && command[0] === "status") ||
    (command.length === 2 && command[0] === "models" && command[1] === "list") ||
    (command.length === 3 &&
      (command[0] === "codex" || command[0] === "claude") &&
      command[1] === "install" &&
      command[2] === "--no-token") ||
    (command.length === 2 && command[0] === "token" && command[1] === "list") ||
    (command.length === 7 &&
      command[0] === "token" &&
      command[1] === "issue" &&
      isDeploymentTokenPair(command[2], command[6]) &&
      command[3] === "--plane" &&
      command[4] === "data" &&
      command[5] === "--created-by") ||
    (command.length === 3 &&
      command[0] === "token" &&
      command[1] === "revoke" &&
      TOKEN_ID.test(command[2]));
  if (!allowed) {
    throw new Error(`refusing non-allowlisted RouteKit operation: routekit ${args.join(" ")}`);
  }
}

async function routekit(target, args, options = {}) {
  const invocation = [...targetArgs(target), ...args];
  assertAllowedRoutekit(invocation);
  return await mustRun("routekit", invocation, options);
}

function routekitJson(target, args) {
  return routekit(target, ["--json", ...args]).then((output) => jsonOutput(output, "routekit"));
}

function integrationTargetEquals(entry, target) {
  if (!isRecord(entry) || !isRecord(entry.target)) return false;
  if (target.kind === "local") return entry.target.kind === "local";
  return entry.target.kind === "remote" && entry.target.name === target.name;
}

function readNativeRegistry(path) {
  if (!existsSync(path)) return { version: 1, integrations: [] };
  requireRegular(path, "native integration registry");
  const parsed = jsonOutput(readText(path), "native integration registry");
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.integrations)) {
    throw new Error("native integration registry has an unsupported format");
  }
  return parsed;
}

/**
 * An installer writes client configuration in place.  Refuse a symlinked
 * config file or direct config directory rather than following it into an
 * operator-managed location that this deployment does not own.
 */
function assertClientConfigPath(paths, tool) {
  const configPath = tool === "codex" ? paths.codexConfigPath : paths.claudeConfigPath;
  const configDirectory = dirname(configPath);
  if (existsSync(configDirectory)) {
    const directory = lstatSync(configDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error(`refusing non-directory or symlinked ${tool} configuration directory`);
    }
  }
  if (existsSync(configPath)) requireRegular(configPath, `${tool} configuration`);
}

function untrackedIntegrationArtifacts(paths, tool) {
  const artifacts =
    tool === "codex"
      ? [paths.codexProfilePath, paths.codexCatalogPath]
      : [paths.claudeOwnershipPath];
  for (const artifact of artifacts) {
    if (!existsSync(artifact)) continue;
    requireRegular(artifact, `RouteKit ${tool} ownership artifact`);
    return true;
  }
  return false;
}

function codexBlockPresent(paths) {
  if (!existsSync(paths.codexConfigPath)) return false;
  const content = readText(paths.codexConfigPath);
  return (
    content.includes("# >>> routekit integration >>>") &&
    content.includes("# <<< routekit integration <<<")
  );
}

function claudeBlockPresent(paths) {
  if (!existsSync(paths.claudeConfigPath)) return false;
  const parsed = jsonOutput(readText(paths.claudeConfigPath), "Claude settings");
  return (
    isRecord(parsed) &&
    isRecord(parsed.env) &&
    typeof parsed.env.ANTHROPIC_BASE_URL === "string" &&
    parsed.env.ANTHROPIC_BASE_URL.length > 0
  );
}

function parseCodexProfile(paths) {
  requireRegular(paths.codexProfilePath, "RouteKit Codex profile");
  const content = readText(paths.codexProfilePath);
  const value = (key) => {
    const match = content.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"));
    if (match?.[1] === undefined) throw new Error(`RouteKit Codex profile is missing ${key}`);
    try {
      return JSON.parse(match[1]);
    } catch {
      throw new Error(`RouteKit Codex profile has an invalid ${key}`);
    }
  };
  const model = value("model");
  const modelProvider = value("model_provider");
  const modelCatalogPath = value("model_catalog_json");
  if (
    typeof model !== "string" ||
    typeof modelProvider !== "string" ||
    typeof modelCatalogPath !== "string" ||
    modelProvider !== ROUTEKIT_OWNER ||
    !isAbsolute(modelCatalogPath)
  ) {
    throw new Error("RouteKit Codex profile is not usable by T3");
  }
  requireRegular(modelCatalogPath, "RouteKit Codex catalog");
  return {
    model,
    modelProvider,
    modelCatalogPath,
    launchArgs: `-c model=${JSON.stringify(model)} -c model_provider=${JSON.stringify(modelProvider)} -c model_catalog_json=${JSON.stringify(modelCatalogPath)}`
  };
}

function parseClaudeGateway(paths) {
  requireRegular(paths.claudeConfigPath, "Claude settings");
  const parsed = jsonOutput(readText(paths.claudeConfigPath), "Claude settings");
  const baseUrl =
    isRecord(parsed) && isRecord(parsed.env) ? parsed.env.ANTHROPIC_BASE_URL : undefined;
  if (typeof baseUrl !== "string")
    throw new Error("RouteKit Claude settings are missing ANTHROPIC_BASE_URL");
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RouteKit Claude settings have an unsupported gateway URL");
  }
  return url.toString().replace(/\/$/, "");
}

function routekitConfigGateway(paths, target) {
  if (target.kind === "local") return undefined;
  if (!existsSync(paths.remotesPath))
    throw new Error(`named RouteKit remote is not configured: ${target.name}`);
  const parsed = jsonOutput(readText(paths.remotesPath), "RouteKit remote registry");
  if (!isRecord(parsed) || !Array.isArray(parsed.remotes))
    throw new Error("RouteKit remote registry has an unsupported format");
  const remote = parsed.remotes.find((entry) => isRecord(entry) && entry.name === target.name);
  if (!isRecord(remote) || typeof remote.gatewayUrl !== "string") {
    throw new Error(`named RouteKit remote is not configured: ${target.name}`);
  }
  return remote.gatewayUrl.replace(/\/$/, "");
}

function deploymentOwnsIntegration(manifest, tool) {
  if (!isRecord(manifest) || !isRecord(manifest.integrations)) return false;
  return manifest.integrations[tool]?.ownership === "created";
}

async function inspectIntegration({ paths, manifest, target, tool }) {
  assertClientConfigPath(paths, tool);
  const registry = readNativeRegistry(paths.nativeRegistryPath);
  const configPath = tool === "codex" ? paths.codexConfigPath : paths.claudeConfigPath;
  const blockPresent = tool === "codex" ? codexBlockPresent(paths) : claudeBlockPresent(paths);
  const entry = registry.integrations.find(
    (candidate) =>
      isRecord(candidate) && candidate.tool === tool && candidate.configPath === configPath
  );
  if (
    !blockPresent &&
    entry === undefined &&
    untrackedIntegrationArtifacts(paths, tool) &&
    !deploymentOwnsIntegration(manifest, tool)
  ) {
    throw new Error(
      `found untracked RouteKit ${tool} ownership files without a complete integration; refusing to recover or alter them`
    );
  }
  if (blockPresent && entry === undefined) {
    if (deploymentOwnsIntegration(manifest, tool))
      return { ownership: "created", requiresInstall: false };
    throw new Error(
      `found an untracked RouteKit ${tool} configuration block; refusing to adopt or alter it`
    );
  }
  if (!blockPresent && entry !== undefined) {
    throw new Error(
      `RouteKit native registry records ${tool}, but its configuration is missing; refusing to repair it`
    );
  }
  if (entry !== undefined) {
    if (!integrationTargetEquals(entry, target)) {
      throw new Error(
        `existing RouteKit ${tool} integration targets a different gateway; refusing to replace it`
      );
    }
    return { ownership: "existing", requiresInstall: false };
  }
  if (deploymentOwnsIntegration(manifest, tool)) {
    throw new Error(
      `deployment-owned RouteKit ${tool} configuration is missing; refusing to recreate it`
    );
  }
  return { ownership: "created", requiresInstall: true };
}

async function ensureIntegration({ paths, manifest, target, tool, inspected: preflight }) {
  const beforeRegistry = snapshot(paths.nativeRegistryPath);
  const inspected = preflight ?? (await inspectIntegration({ paths, manifest, target, tool }));
  if (inspected.requiresInstall) {
    const args =
      tool === "codex" ? ["codex", "install", "--no-token"] : ["claude", "install", "--no-token"];
    await routekit(target, args);
  }
  sameSnapshot(paths.nativeRegistryPath, beforeRegistry, "native integration registry");
  const present = tool === "codex" ? codexBlockPresent(paths) : claudeBlockPresent(paths);
  if (!present) throw new Error(`RouteKit ${tool} integration was not installed`);
  return inspected.ownership;
}

function expectedManifestPaths(paths) {
  return {
    root: paths.root,
    t3Home: paths.t3Home,
    wrapperPath: paths.wrapperPath,
    plistPath: paths.plistPath,
    manifestPath: paths.manifestPath,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    t3SettingsPath: paths.t3SettingsPath
  };
}

function validTokenRecord(value) {
  return (
    isRecord(value) &&
    TOKEN_ID.test(String(value.id)) &&
    typeof value.label === "string" &&
    typeof value.createdBy === "string" &&
    typeof value.tokenSha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(value.tokenSha256) &&
    typeof value.keychainAccount === "string" &&
    typeof value.keychainStored === "boolean"
  );
}

function validateManifest(manifest, paths) {
  if (
    !isRecord(manifest) ||
    ![LEGACY_DEPLOYMENT_VERSION, DEPLOYMENT_VERSION].includes(manifest.version)
  ) {
    throw new Error("deployment manifest has an unsupported format");
  }
  if (!["deploying", "active", "destroying", "destroyed"].includes(manifest.state)) {
    throw new Error("deployment manifest has an invalid state");
  }
  if (
    manifest.id !== paths.id ||
    manifest.label !== paths.label ||
    manifest.keychainService !== KEYCHAIN_SERVICE
  ) {
    throw new Error("deployment manifest does not own this target path");
  }
  if (typeof manifest.nonce !== "string" || !/^[a-f0-9]{24}$/i.test(manifest.nonce)) {
    throw new Error("deployment manifest has an invalid ownership nonce");
  }
  if (!isRecord(manifest.paths)) throw new Error("deployment manifest is missing paths");
  for (const [key, expected] of Object.entries(expectedManifestPaths(paths))) {
    if (manifest.paths[key] !== expected)
      throw new Error(`deployment manifest path mismatch: ${key}`);
  }
  if (!isRecord(manifest.assets))
    throw new Error("deployment manifest is missing managed asset hashes");
  const assetKeys = ["wrapper", "plist", "t3Settings"];
  if (manifest.version === DEPLOYMENT_VERSION) assetKeys.push("t3SshShim");
  for (const key of assetKeys) {
    if (typeof manifest.assets[key] !== "string" || !/^[a-f0-9]{64}$/i.test(manifest.assets[key])) {
      throw new Error(`deployment manifest has an invalid ${key} hash`);
    }
  }
  if (
    !isRecord(manifest.tokens) ||
    !validTokenRecord(manifest.tokens.codex) ||
    !validTokenRecord(manifest.tokens.claude)
  ) {
    throw new Error("deployment manifest is missing deployment-owned token proofs");
  }
  for (const tool of ["codex", "claude"]) {
    const record = manifest.tokens[tool];
    const expectedAccount = `t3-routekit-${paths.id}.${manifest.nonce}.${tool}`;
    const legacyDestroyedAccount = `t3-routekit-${paths.id}.${tool}`;
    if (
      record.label !== `t3-routekit-${paths.id}-${manifest.nonce}-${tool}` ||
      record.createdBy !== `t3-routekit:${paths.id}:${manifest.nonce}:${tool}` ||
      (record.keychainAccount !== expectedAccount &&
        !(manifest.state === "destroyed" && record.keychainAccount === legacyDestroyedAccount))
    ) {
      throw new Error(`deployment manifest has an invalid ${tool} token ownership proof`);
    }
  }
  if (!isRecord(manifest.integrations))
    throw new Error("deployment manifest is missing integration ownership");
  for (const tool of ["codex", "claude"]) {
    if (!["existing", "created"].includes(manifest.integrations[tool]?.ownership)) {
      throw new Error(`deployment manifest has an invalid ${tool} ownership record`);
    }
  }
  if (
    !isRecord(manifest.t3Settings) ||
    manifest.t3Settings.ownership !== "managed" ||
    !["planned", "written", undefined].includes(manifest.t3Settings.state) ||
    (manifest.state === "active" && manifest.t3Settings.state !== "written") ||
    (manifest.state !== "destroyed" && manifest.t3Settings.state === undefined)
  ) {
    throw new Error("deployment manifest is missing T3 settings ownership");
  }
  if (manifest.version === DEPLOYMENT_VERSION) {
    const shim = validateT3SshShimRecord(manifest.t3SshShim, paths);
    if (manifest.state === "active" && shim.state !== "written") {
      throw new Error("active deployment is missing its installed T3 SSH shim");
    }
  }
  return manifest;
}

function readManifest(paths) {
  if (!existsSync(paths.manifestPath)) return undefined;
  requireRegular(paths.manifestPath, "deployment manifest");
  return validateManifest(jsonOutput(readText(paths.manifestPath), "deployment manifest"), paths);
}

function saveManifest(paths, manifest) {
  validateManifest(manifest, paths);
  writePrivateAtomic(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function makeManifest(paths, input) {
  const time = new Date().toISOString();
  // A fresh high-entropy nonce makes a staged token label a practical ownership
  // proof even if this process dies after `token issue` and before it can
  // persist the returned token ID. The public deployment id stays stable so
  // destroy remains a one-command operation.
  const nonce = randomBytes(12).toString("hex");
  const token = (tool) => ({
    id: "0000000000000000",
    label: `t3-routekit-${paths.id}-${nonce}-${tool}`,
    createdBy: `t3-routekit:${paths.id}:${nonce}:${tool}`,
    tokenSha256: "0".repeat(64),
    keychainAccount: `t3-routekit-${paths.id}.${nonce}.${tool}`,
    keychainStored: false
  });
  return {
    version: DEPLOYMENT_VERSION,
    state: "deploying",
    id: paths.id,
    label: paths.label,
    keychainService: KEYCHAIN_SERVICE,
    nonce,
    createdAt: time,
    updatedAt: time,
    port: input.port,
    t3Version: input.t3Version,
    topology: input.routekit,
    paths: expectedManifestPaths(paths),
    assets: {
      wrapper: "0".repeat(64),
      plist: "0".repeat(64),
      t3Settings: "0".repeat(64),
      t3SshShim: sha256(t3SshShimContent(input.t3SshShim.entryPath))
    },
    tokens: { codex: token("codex"), claude: token("claude") },
    integrations: {
      codex: { ownership: "created" },
      claude: { ownership: "created" }
    },
    t3Settings: { ownership: "managed", state: "planned" },
    t3SshShim: input.t3SshShim,
    projects: []
  };
}

function manifestTouchesOnlyExpected(manifest, paths) {
  validateManifest(manifest, paths);
  return true;
}

function assertAssetHash(path, expected, label, allowMissing = false) {
  if (!existsSync(path)) {
    if (allowMissing) return false;
    throw new Error(`${label} is missing`);
  }
  requireRegular(path, label);
  if (sha256(readText(path)) !== expected)
    throw new Error(`${label} has changed; refusing to alter it`);
  return true;
}

function removeOwnedDirectory(path, label) {
  if (!existsSync(path)) return false;
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`refusing to remove non-directory or symlinked ${label}`);
  }
  rmSync(path, { recursive: true, force: false });
  return true;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * SSH processes on macOS do not have an Aqua keychain session and commonly
 * default to the System keychain. A one-shot GUI-domain LaunchAgent reaches
 * the user's login keychain without changing its default. Plaintext travels
 * only over a random one-shot loopback capability: bridge files, plist,
 * launchd metadata, and result files contain no RouteKit credential.
 */
async function guiKeychain(paths, input) {
  const capability = randomBytes(24).toString("hex");
  const suffix = capability.slice(0, 16);
  const label = `com.velum.routekit.t3.keychain.${suffix}`;
  const bridgeRoot = join(paths.root, ".keychain-bridge");
  const scriptPath = join(bridgeRoot, `${suffix}.sh`);
  const plistPath = join(bridgeRoot, `${suffix}.plist`);
  const resultPath = join(bridgeRoot, `${suffix}.result`);
  const domain = await launchctlDomain();
  let received;
  let served = false;
  const server = createServer((request, response) => {
    if (request.url !== `/${capability}` || served) {
      response.writeHead(404).end();
      return;
    }
    served = true;
    if (input.operation === "add") {
      response.writeHead(200, { "content-type": "text/plain" }).end(input.token);
      return;
    }
    if (input.operation === "read") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received = Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
        response.writeHead(200).end("ok");
      });
      return;
    }
    response.writeHead(200).end("ok");
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("could not bind Keychain bridge");
  const endpoint = `http://127.0.0.1:${address.port}/${capability}`;
  const account = shellQuote(input.account);
  const common = `-s ${shellQuote(KEYCHAIN_SERVICE)} -a ${account}`;
  const command =
    input.operation === "add"
      ? `token=$(/usr/bin/curl --fail --silent --show-error --noproxy '*' ${shellQuote(endpoint)})\n` +
        `test -n "$token"\n` +
        `/usr/bin/security add-generic-password ${common} -l ${shellQuote(`RouteKit T3 deployment ${input.account}`)} -w "$token" >/dev/null`
      : input.operation === "read"
        ? `token=$(/usr/bin/security find-generic-password ${common} -w)\n` +
          `test -n "$token"\n` +
          `print -rn -- "$token" | /usr/bin/curl --fail --silent --show-error --noproxy '*' --data-binary @- ${shellQuote(endpoint)} >/dev/null`
        : `/usr/bin/security delete-generic-password ${common} >/dev/null`;
  const script = `#!/bin/zsh
set -eu
umask 077
if ${command}; then
  print -r -- ok > ${shellQuote(resultPath)}
else
  print -r -- failed > ${shellQuote(resultPath)}
fi
`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${scriptPath}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`;
  try {
    mkdirSync(bridgeRoot, { recursive: true, mode: 0o700 });
    chmodSync(bridgeRoot, 0o700);
    writeNewOwnedFile(scriptPath, script, 0o700);
    writeNewOwnedFile(plistPath, plist, 0o600);
    await mustRun("/bin/launchctl", ["bootstrap", domain, plistPath]);
    const deadline = Date.now() + 30_000;
    while (!existsSync(resultPath) && Date.now() < deadline) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
    if (!existsSync(resultPath) || readText(resultPath).trim() !== "ok") {
      throw new Error(
        `could not ${input.operation} deployment Keychain account ${input.account} through the GUI session`
      );
    }
    if (input.operation === "read") return received;
    return undefined;
  } finally {
    if (await launchctlLoaded(domain, label)) {
      await run("/bin/launchctl", ["bootout", domain, plistPath]).catch(() => undefined);
    }
    for (const path of [scriptPath, plistPath, resultPath]) {
      if (existsSync(path)) unlinkSync(path);
    }
    try {
      rmdirSync(bridgeRoot);
    } catch {
      // A user-created file in the transient directory is never removed.
    }
    if (server.listening) {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    }
  }
}

async function keychainRead(paths, account) {
  try {
    return await guiKeychain(paths, { operation: "read", account });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/could not read|failed/i.test(message)) return undefined;
    throw error;
  }
}

async function keychainAdd(paths, account, token) {
  await guiKeychain(paths, { operation: "add", account, token });
}

async function keychainDeleteVerified(paths, record) {
  const stored = await keychainRead(paths, record.keychainAccount);
  if (stored === undefined) return false;
  if (sha256(stored) !== record.tokenSha256) {
    throw new Error(
      `Keychain account ${record.keychainAccount} no longer contains the deployment credential; refusing to delete it`
    );
  }
  await guiKeychain(paths, { operation: "delete", account: record.keychainAccount });
  return true;
}

async function listTokens(target) {
  const parsed = await routekitJson(target, ["token", "list"]);
  if (!isRecord(parsed) || !Array.isArray(parsed.tokens))
    throw new Error("RouteKit token list has an unsupported format");
  return parsed.tokens;
}

function matchingToken(tokens, record) {
  const match = tokens.find(
    (entry) =>
      isRecord(entry) &&
      entry.id === record.id &&
      entry.label === record.label &&
      entry.createdBy === record.createdBy &&
      entry.plane === "data" &&
      entry.role === "admin"
  );
  if (match === undefined)
    throw new Error(
      `RouteKit token ${record.id} no longer matches this deployment; refusing to revoke it`
    );
  return match;
}

async function issueToken(paths, manifest, target, tool) {
  const record = manifest.tokens[tool];
  const output = await routekitJson(target, [
    "token",
    "issue",
    record.label,
    "--plane",
    "data",
    "--created-by",
    record.createdBy
  ]);
  if (
    !isRecord(output) ||
    !TOKEN_ID.test(String(output.id)) ||
    typeof output.token !== "string" ||
    output.token.length === 0 ||
    output.label !== record.label ||
    output.plane !== "data" ||
    output.role !== "admin"
  ) {
    throw new Error("RouteKit returned an invalid service token response");
  }
  record.id = output.id;
  record.tokenSha256 = sha256(output.token);
  manifest.updatedAt = new Date().toISOString();
  saveManifest(paths, manifest);
  try {
    await keychainAdd(paths, record.keychainAccount, output.token);
  } finally {
    // Deliberately discard plaintext as soon as Keychain receives it.
    output.token = "";
  }
  record.keychainStored = true;
  manifest.updatedAt = new Date().toISOString();
  saveManifest(paths, manifest);
}

async function verifyToken(paths, target, record, protocol) {
  const token = await keychainRead(paths, record.keychainAccount);
  if (token === undefined || sha256(token) !== record.tokenSha256) {
    throw new Error(`deployment Keychain credential is unavailable for ${record.keychainAccount}`);
  }
  const gateway = protocol.gatewayUrl;
  const headers =
    protocol.kind === "claude"
      ? { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${token}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${gateway}/v1/models`, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`gateway credential check returned HTTP ${response.status}`);
    const body = await response.json();
    if (!isRecord(body) || !Array.isArray(body.data) || body.data.length === 0) {
      throw new Error("gateway credential check returned no models");
    }
  } finally {
    clearTimeout(timer);
  }
}

function wrapperContent(paths, input) {
  const required = [
    "t3Path",
    "nodePath",
    "codexPath",
    "claudePath",
    "codexLaunchArgs",
    "claudeBaseUrl",
    "codexAccount",
    "claudeAccount"
  ];
  for (const name of required) {
    if (typeof input[name] !== "string" || input[name].length === 0)
      throw new Error(`missing wrapper input ${name}`);
  }
  const directories = [input.t3Path, input.nodePath, input.codexPath, input.claudePath]
    .map((value) => dirname(value))
    .concat(["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  const pathValue = [...new Set(directories)].join(":");
  return `#!/bin/zsh
set -eu
umask 077
export PATH=${shellQuote(pathValue)}
export HOME=${shellQuote(paths.home)}
ROUTEKIT_GATEWAY_TOKEN=$(/usr/bin/security find-generic-password -s ${shellQuote(KEYCHAIN_SERVICE)} -a ${shellQuote(input.codexAccount)} -w)
ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s ${shellQuote(KEYCHAIN_SERVICE)} -a ${shellQuote(input.claudeAccount)} -w)
if [ -z "$ROUTEKIT_GATEWAY_TOKEN" ] || [ -z "$ANTHROPIC_AUTH_TOKEN" ]; then
  print -u2 -- "RouteKit T3 deployment is missing a deployment-owned Keychain credential"
  exit 78
fi
export ROUTEKIT_GATEWAY_TOKEN
export ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_BASE_URL=${shellQuote(input.claudeBaseUrl)}
export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1
export T3CODE_CODEX_LAUNCH_ARGS=${shellQuote(input.codexLaunchArgs)}
/bin/launchctl setenv ROUTEKIT_GATEWAY_TOKEN "$ROUTEKIT_GATEWAY_TOKEN"
/bin/launchctl setenv ANTHROPIC_AUTH_TOKEN "$ANTHROPIC_AUTH_TOKEN"
/bin/launchctl setenv ANTHROPIC_BASE_URL "$ANTHROPIC_BASE_URL"
/bin/launchctl setenv CLAUDE_CODE_ALWAYS_ENABLE_EFFORT "$CLAUDE_CODE_ALWAYS_ENABLE_EFFORT"
exec ${shellQuote(input.t3Path)} serve --host 127.0.0.1 --port ${String(input.port)} --base-dir ${shellQuote(paths.t3Home)}
`;
}

function t3SshShimContent(entryPath) {
  if (typeof entryPath !== "string" || !isAbsolute(entryPath)) {
    throw new Error("T3 SSH shim entry path must be absolute");
  }
  return `#!/bin/zsh
set -eu
read_gui_environment() {
  local key="$1"
  /bin/launchctl print "gui/$(/usr/bin/id -u)" 2>/dev/null | /usr/bin/awk -v key="$key" '
    $1 == key && $2 == "=>" {
      sub(/^[^=]*=>[[:space:]]*/, "")
      if ($0 ~ /^".*"$/) {
        sub(/^"/, "")
        sub(/"$/, "")
      }
      print
      exit
    }
  '
}
for key in \\
  ROUTEKIT_GATEWAY_TOKEN \\
  ANTHROPIC_AUTH_TOKEN \\
  ANTHROPIC_BASE_URL \\
  CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
do
  value="$(read_gui_environment "$key")"
  if [ -n "$value" ]; then
    export "$key=$value"
  fi
done
exec ${shellQuote(entryPath)} "$@"
`;
}

function validateT3SshShimRecord(record, paths) {
  if (
    !isRecord(record) ||
    record.ownership !== "managed" ||
    !["planned", "written"].includes(record.state) ||
    typeof record.path !== "string" ||
    !isAbsolute(record.path) ||
    basename(record.path) !== "t3" ||
    !(
      record.path.startsWith(`${paths.home}/`) ||
      record.path.startsWith("/opt/homebrew/bin/") ||
      record.path.startsWith("/usr/local/bin/")
    ) ||
    record.originalType !== "symlink" ||
    typeof record.originalTarget !== "string" ||
    record.originalTarget.length === 0 ||
    typeof record.entryPath !== "string" ||
    !isAbsolute(record.entryPath)
  ) {
    throw new Error("deployment manifest has an invalid T3 SSH shim ownership record");
  }
  const originalPath = resolve(dirname(record.path), record.originalTarget);
  if (realpathSync(originalPath) !== record.entryPath) {
    throw new Error("deployment T3 SSH shim no longer resolves to its recorded package entry");
  }
  return record;
}

function planT3SshShim(paths, t3Path) {
  if (!isAbsolute(t3Path) || basename(t3Path) !== "t3") {
    throw new Error("installed T3 executable path is not a supported absolute t3 path");
  }
  if (
    !(
      t3Path.startsWith(`${paths.home}/`) ||
      t3Path.startsWith("/opt/homebrew/bin/") ||
      t3Path.startsWith("/usr/local/bin/")
    )
  ) {
    throw new Error("installed T3 executable is outside supported user package-manager paths");
  }
  const entry = lstatSync(t3Path);
  if (!entry.isSymbolicLink()) {
    throw new Error(
      "installed T3 executable is not its original package symlink; restore it before deploying"
    );
  }
  const originalTarget = readlinkSync(t3Path);
  const entryPath = realpathSync(t3Path);
  requireRegular(entryPath, "installed T3 package entry");
  return {
    ownership: "managed",
    state: "planned",
    path: t3Path,
    originalType: "symlink",
    originalTarget,
    entryPath
  };
}

function installT3SshShim(paths, manifest) {
  const record = validateT3SshShimRecord(manifest.t3SshShim, paths);
  const current = lstatSync(record.path);
  if (!current.isSymbolicLink() || readlinkSync(record.path) !== record.originalTarget) {
    throw new Error("T3 executable changed before the deployment SSH shim could be installed");
  }
  const content = t3SshShimContent(record.entryPath);
  if (sha256(content) !== manifest.assets.t3SshShim) {
    throw new Error("deployment T3 SSH shim content does not match its manifest hash");
  }
  const temporary = `${record.path}.routekit-${paths.id}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temporary, content, { mode: 0o700, flag: "wx" });
  try {
    chmodSync(temporary, 0o700);
    renameSync(temporary, record.path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  record.state = "written";
  manifest.updatedAt = new Date().toISOString();
  saveManifest(paths, manifest);
}

function assertT3SshShim(paths, manifest) {
  const record = validateT3SshShimRecord(manifest.t3SshShim, paths);
  if (record.state !== "written") {
    throw new Error("deployment T3 SSH shim installation is incomplete");
  }
  assertAssetHash(record.path, manifest.assets.t3SshShim, "T3 SSH launcher shim");
}

function assertT3SshShimRestorable(paths, manifest) {
  const record = validateT3SshShimRecord(manifest.t3SshShim, paths);
  const entry = lstatSync(record.path);
  if (entry.isSymbolicLink()) {
    if (readlinkSync(record.path) !== record.originalTarget) {
      throw new Error("T3 executable symlink changed; refusing to alter it");
    }
    return;
  }
  assertAssetHash(record.path, manifest.assets.t3SshShim, "T3 SSH launcher shim");
}

function restoreT3SshShim(paths, manifest) {
  if (manifest.version === LEGACY_DEPLOYMENT_VERSION) return false;
  const record = validateT3SshShimRecord(manifest.t3SshShim, paths);
  const entry = lstatSync(record.path);
  if (entry.isSymbolicLink()) {
    if (readlinkSync(record.path) !== record.originalTarget) {
      throw new Error("T3 executable symlink changed; refusing to restore over it");
    }
    return false;
  }
  assertAssetHash(record.path, manifest.assets.t3SshShim, "T3 SSH launcher shim");
  const temporary = `${record.path}.routekit-restore-${paths.id}-${randomBytes(6).toString("hex")}`;
  symlinkSync(record.originalTarget, temporary);
  try {
    renameSync(temporary, record.path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  if (realpathSync(record.path) !== record.entryPath) {
    throw new Error("restored T3 executable does not resolve to its recorded package entry");
  }
  return true;
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistContent(paths) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(paths.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(paths.wrapperPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(paths.root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(paths.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.stderrPath)}</string>
</dict>
</plist>
`;
}

async function t3Version(path) {
  const output = await mustRun(path, ["--version"]);
  const match = output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/);
  if (match?.[1] === undefined) throw new Error("could not parse installed T3 version");
  return match[1];
}

async function ensureT3(input) {
  let t3Path;
  let installed;
  try {
    t3Path = await commandPath("t3", { resolveSymlink: false });
    installed = await t3Version(t3Path);
  } catch (error) {
    if (
      !/ENOENT|not found|which t3 failed/i.test(
        error instanceof Error ? error.message : String(error)
      )
    )
      throw error;
  }
  if (installed === undefined) {
    if (input.dryRun) return { action: "would-install", version: input.t3Version };
    await mustRun("npm", ["install", "--global", `t3@${input.t3Version}`], { timeoutMs: 300_000 });
    t3Path = await commandPath("t3", { resolveSymlink: false });
    installed = await t3Version(t3Path);
    if (installed !== input.t3Version)
      throw new Error(`installed T3 ${installed}, expected ${input.t3Version}`);
    return { action: "installed", version: installed, path: t3Path };
  }
  if (installed !== input.t3Version) {
    if (!input.upgradeT3) {
      throw new Error(
        `T3 ${installed} is installed; use --upgrade-t3 --yes to explicitly replace it with ${input.t3Version}`
      );
    }
    if (input.dryRun) return { action: "would-upgrade", from: installed, version: input.t3Version };
    await mustRun("npm", ["install", "--global", `t3@${input.t3Version}`], { timeoutMs: 300_000 });
    t3Path = await commandPath("t3", { resolveSymlink: false });
    installed = await t3Version(t3Path);
    if (installed !== input.t3Version)
      throw new Error(`installed T3 ${installed}, expected ${input.t3Version}`);
    return { action: "upgraded", version: installed, path: t3Path };
  }
  return { action: "existing", version: installed, path: t3Path };
}

async function launchctlDomain() {
  const output = await mustRun("/usr/bin/id", ["-u"]);
  const uid = Number(output.trim());
  if (!Number.isInteger(uid) || uid < 1) throw new Error("could not determine launchd user domain");
  return `gui/${uid}`;
}

async function launchctlLoaded(domain, label) {
  const result = await run("/bin/launchctl", ["print", `${domain}/${label}`]);
  if (result.code === 0) return true;
  if (/could not find service|not found|no such process/i.test(result.stderr)) return false;
  return false;
}

async function portInUse(port) {
  const result = await run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  if (result.code === 0) return result.stdout.trim().length > 0;
  if (result.code === 1) return false;
  throw new Error(`could not inspect TCP port ${port}: ${result.stderr.trim()}`);
}

async function t3ListenerPids(port) {
  const result = await run("/usr/sbin/lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  if (result.code === 1) return [];
  if (result.code !== 0)
    throw new Error(`could not inspect TCP port ${port}: ${result.stderr.trim()}`);
  return [...new Set(result.stdout.split(/\s+/).filter((value) => /^\d+$/.test(value)))].map(
    Number
  );
}

async function stopDefaultT3Listeners(port) {
  const pids = await t3ListenerPids(port);
  if (pids.length === 0) return false;
  for (const pid of pids) {
    const command = await mustRun("/bin/ps", ["-p", String(pid), "-o", "command="]);
    if (!/(?:^|[/\s])t3(?:\s|$)|\bT3 Code\b/i.test(command)) {
      throw new Error(
        `port ${port} is already in use by a process that is not T3; refusing to replace it`
      );
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return true;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  throw new Error(`the existing T3 listener on port ${port} did not stop`);
}

async function waitForT3(port) {
  const deadline = Date.now() + 45_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }
  throw new Error(
    `T3 did not become healthy on 127.0.0.1:${port}${lastError ? ` (${lastError})` : ""}`
  );
}

function validateProject(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("--project paths must be absolute");
  const entry = statSync(path);
  if (!entry.isDirectory()) throw new Error(`project path is not a directory: ${path}`);
  return realpathSync(path);
}

async function addProjects(t3Path, paths, projects) {
  const added = [];
  for (const rawPath of [...new Set(projects)]) {
    const project = validateProject(rawPath);
    const result = await run(t3Path, ["project", "add", "--base-dir", paths.t3Home, project]);
    if (result.code === 0) {
      added.push(project);
      continue;
    }
    const detail = `${result.stdout}\n${result.stderr}`;
    if (/An active project already exists|already exists/i.test(detail)) {
      added.push(project);
      continue;
    }
    throw new Error(`could not add T3 project ${project}: ${detail.trim()}`);
  }
  return added;
}

function t3SettingsContent(paths, input) {
  const catalog = [...new Set(input.catalog)];
  if (
    catalog.length === 0 ||
    catalog.some((model) => typeof model !== "string" || model.length === 0)
  ) {
    throw new Error("RouteKit returned an invalid live model catalog for T3");
  }
  return `${JSON.stringify(
    {
      providerInstances: {
        codex: {
          driver: "codex",
          displayName: "Codex via RouteKit",
          enabled: true,
          config: {
            binaryPath: input.codexPath,
            launchArgs: input.codexLaunchArgs,
            customModels: catalog
          }
        },
        claudeAgent: {
          driver: "claudeAgent",
          displayName: "Claude via RouteKit",
          enabled: true,
          config: {
            binaryPath: input.claudePath,
            customModels: catalog.map((model) => `anthropic.routekit.${model}`)
          }
        }
      }
    },
    null,
    2
  )}\n`;
}

function assertT3SettingsRoutekit(paths, manifest) {
  requireRegular(paths.t3SettingsPath, "deployment T3 settings");
  const settings = jsonOutput(readText(paths.t3SettingsPath), "deployment T3 settings");
  const providers = isRecord(settings) ? settings.providerInstances : undefined;
  const codex = isRecord(providers) ? providers.codex : undefined;
  const claude = isRecord(providers) ? providers.claudeAgent : undefined;
  if (
    !isRecord(codex) ||
    codex.driver !== "codex" ||
    !isRecord(codex.config) ||
    codex.config.homePath !== undefined ||
    !isRecord(claude) ||
    claude.driver !== "claudeAgent" ||
    !isRecord(claude.config) ||
    claude.config.homePath !== undefined ||
    !Array.isArray(claude.config.customModels) ||
    !claude.config.customModels.some(
      (model) => typeof model === "string" && model.startsWith("anthropic.routekit.")
    )
  ) {
    throw new Error(
      "deployment T3 settings no longer configure both RouteKit harnesses; refusing to overwrite them"
    );
  }
  if (manifest.t3Settings?.ownership !== "managed" || manifest.t3Settings.state !== "written") {
    throw new Error("deployment T3 settings do not have a deployment ownership record");
  }
}

function catalogFromRoutekit(value) {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new Error("RouteKit model catalog has an unsupported format");
  }
  const models = value.models.filter((model) => typeof model === "string");
  if (models.length !== value.models.length || models.length === 0) {
    throw new Error("RouteKit model catalog contains no usable models");
  }
  return models;
}

function routekitStatusValid(status) {
  return (
    isRecord(status) &&
    isRecord(status.daemon) &&
    status.daemon.running !== false &&
    status.daemon.healthy !== false &&
    typeof status.daemon.dataUrl === "string" &&
    isRecord(status.models) &&
    typeof status.models.count === "number" &&
    status.models.count > 0
  );
}

async function verifyRoutekitReady(target) {
  const status = await routekitJson(target, ["status"]);
  if (!routekitStatusValid(status)) {
    throw new Error(
      "the selected RouteKit gateway is not running, healthy, and model-ready; start/repair it outside this deployment first"
    );
  }
  return status.daemon.dataUrl.replace(/\/$/, "");
}

async function verifyHarnessBinaries() {
  const [codexPath, claudePath] = await Promise.all([commandPath("codex"), commandPath("claude")]);
  await Promise.all([mustRun(codexPath, ["--version"]), mustRun(claudePath, ["--version"])]);
  return { codexPath, claudePath };
}

async function recoverDeploying(paths, manifest, target) {
  if (manifest.state !== "deploying") return;
  const tokens = await listTokens(target);
  for (const tool of ["codex", "claude"]) {
    const record = manifest.tokens[tool];
    const entries = tokens.filter(
      (entry) =>
        isRecord(entry) &&
        entry.label === record.label &&
        entry.createdBy === record.createdBy &&
        entry.plane === "data" &&
        entry.role === "admin"
    );
    // A newly-issued token can be interrupted before its ID reaches the
    // manifest.  The random nonce makes one matching record attributable; two
    // records are ambiguous, so preserve both rather than revoking a token a
    // user may have created after observing the label.
    if (entries.length > 1) {
      throw new Error(
        `found multiple RouteKit tokens with deployment ownership proof for ${record.label}; refusing to revoke an ambiguous token`
      );
    }
    const entry = entries[0];
    if (entry !== undefined && entry.revokedAt === undefined) {
      if (record.id !== "0000000000000000" && entry.id !== record.id) {
        throw new Error(`RouteKit token ID for ${record.label} changed; refusing to revoke it`);
      }
      await routekitJson(target, ["token", "revoke", entry.id]);
    }
    if (record.keychainStored === true && record.tokenSha256 !== "0".repeat(64)) {
      await keychainDeleteVerified(paths, record);
    }
  }
  const domain = await launchctlDomain();
  if (await launchctlLoaded(domain, paths.label)) {
    if (manifest.assets.plist === "0".repeat(64)) {
      throw new Error(
        "interrupted deployment has a loaded LaunchAgent without a recorded plist hash"
      );
    }
    assertAssetHash(paths.plistPath, manifest.assets.plist, "LaunchAgent plist");
    await mustRun("/bin/launchctl", ["bootout", domain, paths.plistPath]);
  }
  restoreT3SshShim(paths, manifest);
  const assets = [
    [paths.wrapperPath, manifest.assets.wrapper, "T3 wrapper"],
    [paths.plistPath, manifest.assets.plist, "LaunchAgent plist"],
    [paths.t3SettingsPath, manifest.assets.t3Settings, "T3 settings"]
  ];
  for (const [path, hash, label] of assets) {
    if (hash !== "0".repeat(64) && assertAssetHash(path, hash, label, true)) unlinkSync(path);
  }
  manifest.state = "destroyed";
  manifest.recovery = "interrupted deployment rolled back without touching client integrations";
  manifest.destroyedAt = new Date().toISOString();
  manifest.updatedAt = new Date().toISOString();
  saveManifest(paths, manifest);
}

async function verifyActiveDeployment(paths, manifest, input) {
  if (manifest.port !== input.port || manifest.t3Version !== input.t3Version) {
    throw new Error(
      "an active deployment already exists with different port or T3 version; destroy it first rather than rewriting it"
    );
  }
  if (JSON.stringify(manifest.topology) !== JSON.stringify(input.routekit)) {
    throw new Error(
      "an active deployment already targets a different RouteKit gateway; destroy it first rather than rewriting it"
    );
  }
  assertAssetHash(paths.wrapperPath, manifest.assets.wrapper, "T3 wrapper");
  assertAssetHash(paths.plistPath, manifest.assets.plist, "LaunchAgent plist");
  assertAssetHash(paths.t3SettingsPath, manifest.assets.t3Settings, "T3 settings");
  assertT3SshShim(paths, manifest);
  assertT3SettingsRoutekit(paths, manifest);
  for (const tool of ["codex", "claude"]) {
    const stored = await keychainRead(paths, manifest.tokens[tool].keychainAccount);
    if (stored === undefined || sha256(stored) !== manifest.tokens[tool].tokenSha256) {
      throw new Error(
        `deployment Keychain credential was changed or removed for ${tool}; refusing to replace it`
      );
    }
  }
  const tokens = await listTokens(input.routekit);
  for (const tool of ["codex", "claude"]) {
    const entry = matchingToken(tokens, manifest.tokens[tool]);
    if (entry.revokedAt !== undefined)
      throw new Error(
        `deployment RouteKit token for ${tool} is revoked; destroy and redeploy instead of rotating it`
      );
  }
  const domain = await launchctlDomain();
  if (!(await launchctlLoaded(domain, paths.label))) {
    await mustRun("/bin/launchctl", ["kickstart", `${domain}/${paths.label}`]);
  }
  await waitForT3(manifest.port);
  return manifest;
}

async function deploy(input) {
  if (process.platform !== "darwin")
    throw new Error("T3 RouteKit deployment currently supports macOS targets only");
  const id = safeId(input.deploymentId ?? DEFAULT_DEPLOYMENT_ID, "deployment id");
  const target = input.routekit;
  if (!isRecord(target) || (target.kind !== "local" && target.kind !== "remote")) {
    throw new Error("invalid RouteKit target");
  }
  if (target.kind === "remote") safeRemote(target.name);
  const port = safePort(input.port);
  const t3VersionWanted = exactVersion(input.t3Version);
  const paths = homePaths(id);
  const existing = readManifest(paths);
  const dryRun = input.dryRun === true;
  const routerBefore = snapshot(paths.routerConfigPath);
  const remotesBefore = snapshot(paths.remotesPath);

  if (existing?.state === "active") {
    if (existing.version === LEGACY_DEPLOYMENT_VERSION) {
      if (dryRun) {
        return {
          ok: true,
          action: "would-require-redeploy",
          deploymentId: id,
          reason: "the active deployment predates managed T3 SSH launcher credentials"
        };
      }
      throw new Error(
        "the active T3 deployment predates managed SSH launcher credentials; run t3:destroy and then t3:deploy"
      );
    }
    if (dryRun) {
      return {
        ok: true,
        action: "would-verify-existing",
        deploymentId: id,
        port: existing.port,
        retained: ["RouteKit configuration", "native client configuration", "T3 data"]
      };
    }
    await verifyActiveDeployment(paths, existing, {
      ...input,
      routekit: target,
      port,
      t3Version: t3VersionWanted
    });
    const t3 = await ensureT3({ ...input, t3Version: t3VersionWanted });
    const projects = await addProjects(t3.path, paths, input.projects ?? []);
    existing.projects = [...new Set([...(existing.projects ?? []), ...projects])];
    existing.updatedAt = new Date().toISOString();
    saveManifest(paths, existing);
    return {
      ok: true,
      action: "verified-existing",
      deploymentId: id,
      port,
      projects: existing.projects
    };
  }

  if (existing?.state === "deploying") {
    if (dryRun) {
      return {
        ok: true,
        action: "would-recover-interrupted",
        deploymentId: id,
        state: existing.state
      };
    }
    await recoverDeploying(paths, existing, target);
  }
  if (existing?.state === "destroying") {
    throw new Error(
      "a previous destroy is incomplete; rerun t3:destroy instead of deploying over it"
    );
  }

  const receipt = readManifest(paths);
  if (receipt?.state === "destroyed") manifestTouchesOnlyExpected(receipt, paths);
  if (existing === undefined && existsSync(paths.root)) {
    throw new Error(`refusing existing deployment directory without a manifest: ${paths.root}`);
  }
  if (existing === undefined && (existsSync(paths.wrapperPath) || existsSync(paths.plistPath))) {
    throw new Error("refusing pre-existing RouteKit T3 assets without a manifest");
  }

  // Do every non-mutating safety check before installing T3, writing a
  // manifest, issuing a token, or asking RouteKit to touch a native client.
  // In particular, this detects a partial/untracked RouteKit integration
  // before an installer could try to recover or update it.
  const requestedProjects = [...new Set(input.projects ?? [])].map(validateProject);
  const [gatewayStatusUrl, binaries] = await Promise.all([
    verifyRoutekitReady(target),
    verifyHarnessBinaries()
  ]);
  const integrationPlan = {
    codex: await inspectIntegration({ paths, manifest: receipt, target, tool: "codex" }),
    claude: await inspectIntegration({ paths, manifest: receipt, target, tool: "claude" })
  };

  if (dryRun) {
    return {
      ok: true,
      action: "would-deploy",
      deploymentId: id,
      port,
      routekit: target,
      preserves: ["RouteKit config/accounts/remotes", "existing native client config"],
      replaces: ["an existing T3 listener on the selected port, after verifying it is T3"]
    };
  }

  await stopDefaultT3Listeners(port);
  const t3 = await ensureT3({ ...input, t3Version: t3VersionWanted });
  if (typeof t3.path !== "string")
    throw new Error("T3 installation did not provide an executable path");
  const t3SshShim = planT3SshShim(paths, t3.path);

  if (receipt?.state === "destroyed")
    removeOwnedDirectory(paths.root, "destroyed deployment state");
  const manifest = makeManifest(paths, {
    port,
    t3Version: t3VersionWanted,
    routekit: target,
    t3SshShim
  });
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  chmodSync(paths.root, 0o700);
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  saveManifest(paths, manifest);

  const codexOwnership = await ensureIntegration({
    paths,
    manifest: receipt,
    target,
    tool: "codex",
    inspected: integrationPlan.codex
  });
  manifest.integrations.codex = { ownership: codexOwnership };
  const claudeOwnership = await ensureIntegration({
    paths,
    manifest: receipt,
    target,
    tool: "claude",
    inspected: integrationPlan.claude
  });
  manifest.integrations.claude = { ownership: claudeOwnership };
  manifest.updatedAt = new Date().toISOString();
  saveManifest(paths, manifest);

  sameSnapshot(paths.routerConfigPath, routerBefore, "RouteKit router configuration");
  sameSnapshot(paths.remotesPath, remotesBefore, "RouteKit remote configuration");

  const codexProfile = parseCodexProfile(paths);
  const claudeGateway = parseClaudeGateway(paths);
  const catalog = catalogFromRoutekit(await routekitJson(target, ["models", "list"]));
  const configuredGateway = routekitConfigGateway(paths, target) ?? gatewayStatusUrl;
  if (
    target.kind === "remote" &&
    (claudeGateway !== configuredGateway ||
      !readText(paths.codexConfigPath).includes(`${configuredGateway}/v1`))
  ) {
    throw new Error("native RouteKit integrations do not target the requested remote gateway");
  }
  if (target.kind === "local" && claudeGateway !== gatewayStatusUrl) {
    throw new Error("native RouteKit Claude integration does not target the local gateway");
  }

  await issueToken(paths, manifest, target, "codex");
  await issueToken(paths, manifest, target, "claude");

  const wrapper = wrapperContent(paths, {
    t3Path: t3.path,
    nodePath: process.execPath,
    codexPath: binaries.codexPath,
    claudePath: binaries.claudePath,
    codexLaunchArgs: codexProfile.launchArgs,
    claudeBaseUrl: claudeGateway,
    codexAccount: manifest.tokens.codex.keychainAccount,
    claudeAccount: manifest.tokens.claude.keychainAccount,
    port
  });
  const settings = t3SettingsContent(paths, {
    codexPath: binaries.codexPath,
    claudePath: binaries.claudePath,
    codexLaunchArgs: codexProfile.launchArgs,
    catalog
  });
  writeManagedT3Settings(paths, settings);
  manifest.t3Settings.state = "written";
  manifest.assets.t3Settings = sha256(settings);
  manifest.updatedAt = new Date().toISOString();
  saveManifest(paths, manifest);
  assertT3SettingsRoutekit(paths, manifest);
  const plist = plistContent(paths);
  manifest.assets.wrapper = sha256(wrapper);
  manifest.assets.plist = sha256(plist);
  manifest.updatedAt = new Date().toISOString();
  saveManifest(paths, manifest);
  writeNewOwnedFile(paths.wrapperPath, wrapper, 0o700);
  writeNewOwnedFile(paths.plistPath, plist, 0o600);
  installT3SshShim(paths, manifest);

  const projects = await addProjects(t3.path, paths, requestedProjects);
  manifest.projects = [...new Set(projects)];
  const domain = await launchctlDomain();
  if (await launchctlLoaded(domain, paths.label)) {
    throw new Error(
      `RouteKit T3 LaunchAgent ${paths.label} already exists without an active manifest`
    );
  }
  await mustRun("/bin/launchctl", ["bootstrap", domain, paths.plistPath]);
  await waitForT3(port);
  await verifyToken(paths, target, manifest.tokens.codex, {
    kind: "codex",
    gatewayUrl: configuredGateway
  });
  await verifyToken(paths, target, manifest.tokens.claude, {
    kind: "claude",
    gatewayUrl: configuredGateway
  });
  manifest.state = "active";
  manifest.updatedAt = new Date().toISOString();
  manifest.verifiedAt = manifest.updatedAt;
  saveManifest(paths, manifest);
  sameSnapshot(paths.routerConfigPath, routerBefore, "RouteKit router configuration");
  sameSnapshot(paths.remotesPath, remotesBefore, "RouteKit remote configuration");
  return {
    ok: true,
    action: "deployed",
    deploymentId: id,
    port,
    url: `http://127.0.0.1:${port}`,
    routekit: target,
    t3: { version: t3.version, action: t3.action },
    integrations: manifest.integrations,
    projects: manifest.projects,
    verified: ["T3 health", "Codex deployment token", "Claude deployment token"]
  };
}

async function destroy(input) {
  if (process.platform !== "darwin")
    throw new Error("T3 RouteKit deployment currently supports macOS targets only");
  const id = safeId(input.deploymentId ?? DEFAULT_DEPLOYMENT_ID, "deployment id");
  const paths = homePaths(id);
  const manifest = readManifest(paths);
  if (manifest === undefined) return { ok: true, action: "nothing-to-destroy", deploymentId: id };
  if (manifest.state === "destroyed")
    return { ok: true, action: "already-destroyed", deploymentId: id };
  const target = manifest.topology;
  if (!isRecord(target) || (target.kind !== "local" && target.kind !== "remote")) {
    throw new Error("deployment manifest has an invalid RouteKit target");
  }
  if (manifest.state === "deploying") {
    if (input.dryRun === true) {
      return { ok: true, action: "would-recover-interrupted", deploymentId: id };
    }
    await recoverDeploying(paths, manifest, target);
    return {
      ok: true,
      action: "recovered-interrupted-deployment",
      deploymentId: id,
      preserved: [
        "RouteKit configuration",
        "native client configuration",
        "T3 data",
        "global T3 package"
      ]
    };
  }
  if (input.dryRun === true) {
    return {
      ok: true,
      action: "would-destroy",
      deploymentId: id,
      preserves: [
        "RouteKit configuration",
        "native client configuration",
        "T3 data",
        "global T3 package"
      ]
    };
  }
  const allowMissingAssets = manifest.state === "destroying";
  const wrapperExists = assertAssetHash(
    paths.wrapperPath,
    manifest.assets.wrapper,
    "T3 wrapper",
    allowMissingAssets
  );
  const plistExists = assertAssetHash(
    paths.plistPath,
    manifest.assets.plist,
    "LaunchAgent plist",
    allowMissingAssets
  );
  const settingsExists = assertAssetHash(
    paths.t3SettingsPath,
    manifest.assets.t3Settings,
    "T3 settings",
    allowMissingAssets
  );
  if (manifest.state === "active" && (!wrapperExists || !plistExists || !settingsExists)) {
    throw new Error("deployment assets are missing; refusing to guess what to remove");
  }
  if (manifest.version === DEPLOYMENT_VERSION) {
    if (manifest.state === "active") assertT3SshShim(paths, manifest);
    else assertT3SshShimRestorable(paths, manifest);
  }
  for (const tool of ["codex", "claude"]) {
    const stored = await keychainRead(paths, manifest.tokens[tool].keychainAccount);
    if (stored !== undefined && sha256(stored) !== manifest.tokens[tool].tokenSha256) {
      throw new Error(
        `Keychain account ${manifest.tokens[tool].keychainAccount} was changed; refusing to delete it`
      );
    }
  }
  const tokens = await listTokens(target);
  for (const tool of ["codex", "claude"]) matchingToken(tokens, manifest.tokens[tool]);

  manifest.state = "destroying";
  manifest.updatedAt = new Date().toISOString();
  saveManifest(paths, manifest);

  const domain = await launchctlDomain();
  if (await launchctlLoaded(domain, paths.label)) {
    if (!plistExists) {
      throw new Error(
        "RouteKit T3 LaunchAgent is loaded but its owned plist is missing; refusing to guess what to unload"
      );
    }
    await mustRun("/bin/launchctl", ["bootout", domain, paths.plistPath]);
  }
  restoreT3SshShim(paths, manifest);
  for (const tool of ["codex", "claude"]) {
    const entry = matchingToken(await listTokens(target), manifest.tokens[tool]);
    if (entry.revokedAt === undefined) await routekitJson(target, ["token", "revoke", entry.id]);
  }
  for (const tool of ["codex", "claude"])
    await keychainDeleteVerified(paths, manifest.tokens[tool]);
  if (assertAssetHash(paths.wrapperPath, manifest.assets.wrapper, "T3 wrapper", true))
    unlinkSync(paths.wrapperPath);
  if (assertAssetHash(paths.plistPath, manifest.assets.plist, "LaunchAgent plist", true))
    unlinkSync(paths.plistPath);
  if (assertAssetHash(paths.t3SettingsPath, manifest.assets.t3Settings, "T3 settings", true))
    unlinkSync(paths.t3SettingsPath);
  removeOwnedDirectory(paths.root, "deployment state");
  unlinkSync(paths.manifestPath);
  try {
    rmdirSync(dirname(paths.manifestPath));
  } catch {
    // Other deployment receipts may still be present.
  }
  return {
    ok: true,
    action: "destroyed",
    deploymentId: id,
    removed: ["deployment wrapper", "deployment settings", "deployment logs"],
    preserved: [
      "T3 chats and state",
      "RouteKit configuration",
      "native client configuration",
      "global T3 package"
    ]
  };
}

async function main() {
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
