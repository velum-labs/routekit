/**
 * Helpers for the RouteKit remote Docker lifecycle E2E suite.
 * Pure-ish utilities are unit-tested from scripts/test/remote-docker-e2e.test.mjs;
 * Docker orchestration lives in scripts/routekit-remote-docker-e2e.mjs.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROUTEKIT_SCOPE = "@velum-labs/routekit";
export const ROUTEKIT_PACKAGE = "@velum-labs/routekit";
export const OWNER_USER = "owner";
export const PEER_USER = "peer";
export const SSH_ALIAS = "rk-docker";
export const OWNER_REMOTE_NAME = "docker-owner";
export const PEER_REMOTE_NAME = "docker-peer";

/** Match the installer/CLI allow-list for exact versions and `latest`. */
export function isInstallableVersion(version) {
  return /^(?:latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(version);
}

/**
 * Derive a candidate prerelease that is installable, distinct from the
 * published baseline, and unique per run so Verdaccio republishes cleanly.
 */
export function candidateVersionFor(publishedVersion, runId) {
  if (!/^\d+\.\d+\.\d+$/.test(publishedVersion)) {
    throw new Error(`published version must be exact stable semver, got ${publishedVersion}`);
  }
  const safeRunId = String(runId)
    .replace(/[^0-9A-Za-z.-]/g, "")
    .slice(0, 32);
  if (safeRunId.length === 0) {
    throw new Error("runId must contain at least one alphanumeric character");
  }
  const candidate = `${publishedVersion}-docker.${safeRunId}`;
  if (!isInstallableVersion(candidate)) {
    throw new Error(`derived candidate version is not installable: ${candidate}`);
  }
  if (candidate === publishedVersion) {
    throw new Error("candidate version must differ from the published baseline");
  }
  return candidate;
}

/** Collect the publishable RouteKit package closure starting at the CLI. */
export function collectPackageClosure(root) {
  const packageEntries = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(root, "packages", entry.name);
      const manifestPath = join(directory, "package.json");
      if (!existsSync(manifestPath)) return undefined;
      return {
        directory,
        manifest: JSON.parse(readFileSync(manifestPath, "utf8"))
      };
    })
    .filter((entry) => entry !== undefined);
  const byName = new Map(packageEntries.map((entry) => [entry.manifest.name, entry]));
  const closure = [];
  const pending = [ROUTEKIT_PACKAGE];
  const seen = new Set();
  while (pending.length > 0) {
    const name = pending.shift();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    if (!name.startsWith("@velum-labs/routekit")) {
      throw new Error(`RouteKit package closure reached non-RouteKit dependency ${name}`);
    }
    const entry = byName.get(name);
    if (entry === undefined) {
      throw new Error(`missing workspace package for ${name}`);
    }
    if (entry.manifest.private === true) {
      throw new Error(`publishable closure unexpectedly includes private package ${name}`);
    }
    closure.push(entry);
    for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
      if (dependency.startsWith("@velum-labs/routekit")) {
        pending.push(dependency);
      }
    }
  }
  return closure;
}

/** Rewrite a packed package.json so every RouteKit dep pins the candidate. */
export function rewriteManifestForCandidate(manifest, candidateVersion) {
  const next = structuredClone(manifest);
  next.version = candidateVersion;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const block = next[field];
    if (block === undefined) continue;
    for (const name of Object.keys(block)) {
      if (name.startsWith("@velum-labs/routekit")) {
        block[name] = candidateVersion;
      }
    }
  }
  return next;
}

export function assertCandidateClosureComplete(closure, candidateVersion) {
  if (closure.length === 0) {
    throw new Error("candidate package closure is empty");
  }
  const names = new Set(closure.map((entry) => entry.manifest.name));
  if (!names.has(ROUTEKIT_PACKAGE)) {
    throw new Error(`candidate closure is missing ${ROUTEKIT_PACKAGE}`);
  }
  for (const entry of closure) {
    if (entry.manifest.version !== candidateVersion) {
      throw new Error(
        `${entry.manifest.name} version ${entry.manifest.version} != candidate ${candidateVersion}`
      );
    }
    for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
      if (!dependency.startsWith("@velum-labs/routekit")) continue;
      if (!names.has(dependency)) {
        throw new Error(`${entry.manifest.name} depends on missing ${dependency}`);
      }
      if (entry.manifest.dependencies[dependency] !== candidateVersion) {
        throw new Error(`${entry.manifest.name} must pin ${dependency} to ${candidateVersion}`);
      }
    }
  }
}

export function resolveLatestPublishedVersion({
  packageName = ROUTEKIT_PACKAGE,
  exec = execFileSync
} = {}) {
  const version = exec("npm", ["view", packageName, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`unexpected npm view version for ${packageName}: ${version}`);
  }
  return version;
}

export function freePort() {
  return new Promise((resolvePort, reject) => {
    import("node:net").then(({ createServer }) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close(() => reject(new Error("failed to allocate a free port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolvePort(port);
        });
      });
      server.on("error", reject);
    }, reject);
  });
}

export function redactSensitiveText(text, secrets = []) {
  let next = String(text);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    next = next.split(secret).join("[redacted]");
  }
  next = next.replace(/\brk1_[A-Za-z0-9_-]+\b/g, "[redacted]");
  next = next.replace(/\b(Authorization:\s*Bearer\s+)\S+/gi, "$1[redacted]");
  next = next.replace(/\b(OPENAI_API_KEY|token|password)=([^\s]+)/gi, "$1=[redacted]");
  return next;
}

export function commandTimeoutMs(label, overrides = {}) {
  const table = {
    ssh: 30_000,
    docker: 120_000,
    npmPublish: 180_000,
    remoteInstall: 600_000,
    remoteAdd: 120_000,
    http: 30_000,
    default: 60_000,
    ...overrides
  };
  return table[label] ?? table.default;
}

export class CleanupStack {
  constructor() {
    this.steps = [];
  }

  add(label, fn) {
    this.steps.push({ label, fn });
  }

  async run(log = () => {}) {
    const errors = [];
    while (this.steps.length > 0) {
      const step = this.steps.pop();
      try {
        await step.fn();
        log(`cleanup ok: ${step.label}`);
      } catch (error) {
        errors.push(`${step.label}: ${error instanceof Error ? error.message : String(error)}`);
        log(`cleanup failed: ${step.label}`);
      }
    }
    return errors;
  }
}

export function runCaptured(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = commandTimeoutMs("default"),
    input,
    label = `${command} ${args.join(" ")}`
  } = options;
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const settle = (error, code = 1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(Object.assign(error, { stdout, stderr, code }));
        return;
      }
      resolveRun({ code, stdout, stderr });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => settle(error));
    child.on("close", (code, signal) => {
      if (signal) {
        settle(new Error(`${label} exited from signal ${signal}`), code ?? 1);
        return;
      }
      settle(undefined, code ?? 1);
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

export async function waitForHttpOk(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs("http");
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000)
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

/**
 * Pack the RouteKit closure, rewrite versions to the candidate prerelease, and
 * return publishable package directories under `destination/packages`.
 */
export function packCandidateArtifacts(root, candidateVersion, destination) {
  const packsDir = join(destination, "tarballs");
  const packagesDir = join(destination, "packages");
  mkdirSync(packsDir, { recursive: true });
  mkdirSync(packagesDir, { recursive: true });
  const closure = collectPackageClosure(root);
  for (const entry of closure) {
    execFileSync("pnpm", ["pack", "--pack-destination", packsDir], {
      cwd: entry.directory,
      stdio: "pipe"
    });
  }
  const rewritten = [];
  for (const tarballName of readdirSync(packsDir).filter((name) => name.endsWith(".tgz"))) {
    const tarballPath = join(packsDir, tarballName);
    const packageDir = join(packagesDir, tarballName.replace(/\.tgz$/, ""));
    mkdirSync(packageDir, { recursive: true });
    execFileSync("tar", ["-xzf", tarballPath, "-C", packageDir, "--strip-components=1"], {
      stdio: "pipe"
    });
    const manifestPath = join(packageDir, "package.json");
    const manifest = rewriteManifestForCandidate(
      JSON.parse(readFileSync(manifestPath, "utf8")),
      candidateVersion
    );
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    rewritten.push({
      name: manifest.name,
      version: manifest.version,
      directory: packageDir,
      manifest
    });
  }
  assertCandidateClosureComplete(rewritten, candidateVersion);
  return rewritten;
}

export async function publishCandidateArtifacts(packages, registryUrl, options = {}) {
  const exec = options.exec ?? runCaptured;
  const remaining = new Map(packages.map((entry) => [entry.name, entry]));
  const published = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const [name, entry] of [...remaining.entries()]) {
      const deps = Object.keys(entry.manifest.dependencies ?? {}).filter((dep) =>
        dep.startsWith("@velum-labs/routekit")
      );
      if (deps.some((dep) => remaining.has(dep))) continue;
      const result = await exec(
        "npm",
        ["publish", "--access", "public", "--registry", registryUrl, "--ignore-scripts"],
        {
          cwd: entry.directory,
          timeoutMs: commandTimeoutMs("npmPublish"),
          label: `npm publish ${name}`
        }
      );
      if (result.code !== 0) {
        throw new Error(
          `failed to publish ${name}@${entry.version}: ${result.stderr || result.stdout}`
        );
      }
      published.push(name);
      remaining.delete(name);
      progressed = true;
    }
    if (!progressed) {
      throw new Error(
        `unable to order candidate publishes; remaining: ${[...remaining.keys()].join(", ")}`
      );
    }
  }
  return published;
}

export function writeSshConfig(filePath, input) {
  const blocks = input.hosts.map((host) =>
    [
      `Host ${host.alias}`,
      `  HostName ${host.host}`,
      `  Port ${host.port}`,
      `  User ${host.user}`,
      `  IdentityFile ${host.identityFile}`,
      "  IdentitiesOnly yes",
      "  BatchMode yes",
      "  StrictHostKeyChecking no",
      "  UserKnownHostsFile /dev/null",
      "  GlobalKnownHostsFile /dev/null",
      "  LogLevel ERROR",
      ""
    ].join("\n")
  );
  const contents = blocks.join("\n");
  writeFileSync(filePath, contents, { mode: 0o600 });
  return contents;
}

export function parseJsonOutput(stdout, label = "command") {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} produced no JSON output`);
  }
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Keep scanning upward.
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function modeBits(mode) {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

export function assertMode(path, expected) {
  const mode = modeBits(statSync(path).mode);
  if (mode !== expected) {
    throw new Error(`${path} mode is ${mode}, expected ${expected}`);
  }
}

export function workspaceRootFromModuleUrl(moduleUrl) {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../..");
}

export function ensureEmptyDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

export function requireBinary(name) {
  try {
    execFileSync("sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    throw new Error(`required binary not found on PATH: ${name}`);
  }
}
