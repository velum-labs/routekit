/**
 * Candidate artifact packaging: version selection, closure collection,
 * rewrite, Verdaccio auth, and publish ordering.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import { ROUTEKIT_PACKAGE } from "./constants.mjs";
import { commandTimeoutMs, runCaptured } from "./process.mjs";

export function isInstallableVersion(version) {
  return /^(?:latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(version);
}

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
  if (next.publishConfig !== undefined) {
    const publishConfig = { ...next.publishConfig };
    delete publishConfig.provenance;
    next.publishConfig = publishConfig;
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
        throw new Error(
          `${entry.manifest.name} must pin ${dependency} to ${candidateVersion}`
        );
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

export async function registerVerdaccioUser(registryUrl, input = {}) {
  const name = input.username ?? "routekit-e2e";
  const password = input.password ?? "routekit-e2e-pass";
  const email = input.email ?? "routekit-e2e@example.com";
  const base = registryUrl.endsWith("/") ? registryUrl.slice(0, -1) : registryUrl;
  const response = await fetch(`${base}/-/user/org.couchdb.user:${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name, password, email })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.token !== "string") {
    throw new Error(
      `verdaccio user registration failed (${response.status}): ${JSON.stringify(body)}`
    );
  }
  return { username: name, password, token: body.token };
}

export async function publishCandidateArtifacts(packages, registryUrl, options = {}) {
  const exec = options.exec ?? runCaptured;
  const token = options.token;
  const remaining = new Map(packages.map((entry) => [entry.name, entry]));
  const published = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const [name, entry] of [...remaining.entries()]) {
      const deps = Object.keys(entry.manifest.dependencies ?? {}).filter((dep) =>
        dep.startsWith("@velum-labs/routekit")
      );
      if (deps.some((dep) => remaining.has(dep))) continue;
      if (token !== undefined) {
        const host = new URL(registryUrl).host;
        writeFileSync(
          join(entry.directory, ".npmrc"),
          [
            `registry=${registryUrl}`,
            `@velum-labs:registry=${registryUrl}`,
            `//${host}/:_authToken=${token}`,
            "strict-ssl=false",
            ""
          ].join("\n"),
          { mode: 0o600 }
        );
      }
      const result = await exec(
        "npm",
        [
          "publish",
          "--access",
          "public",
          "--registry",
          registryUrl,
          "--ignore-scripts",
          "--provenance=false"
        ],
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
