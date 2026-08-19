#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_ATTEMPTS = 12;
const DEFAULT_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

function fail(message) {
  throw new Error(`check-npm-release-registry: ${message}`);
}

function positiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${flag} must be a positive integer`);
  return parsed;
}

function parseArgs(argv) {
  const mode = argv[0];
  if (!["names", "versions"].includes(mode)) {
    fail("usage: check-npm-release-registry.mjs <names|versions> [options]");
  }

  const args = {
    mode,
    root: fileURLToPath(new URL("..", import.meta.url)),
    registry: process.env.NPM_CONFIG_REGISTRY ?? DEFAULT_REGISTRY,
    attempts: mode === "versions" ? DEFAULT_ATTEMPTS : 1,
    delayMs: DEFAULT_DELAY_MS
  };

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) fail(`missing value for ${flag}`);
    if (flag === "--root") args.root = resolve(value);
    else if (flag === "--registry") args.registry = value;
    else if (flag === "--attempts") args.attempts = positiveInteger(value, flag);
    else if (flag === "--delay-ms") args.delayMs = positiveInteger(value, flag);
    else fail(`unknown option ${flag}`);
    index += 1;
  }

  return args;
}

function publishablePackages(root) {
  const packagesRoot = resolve(root, "packages");
  const packages = [];

  for (const directory of readdirSync(packagesRoot)) {
    const manifestPath = resolve(packagesRoot, directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.private === true) continue;
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      fail(`${manifestPath} must declare string name and version fields`);
    }
    packages.push({ name: manifest.name, version: manifest.version });
  }

  if (packages.length === 0) fail("no publishable packages found");
  return packages.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function metadataUrl(registry, packageName) {
  return `${registry.replace(/\/+$/u, "")}/${encodeURIComponent(packageName)}`;
}

async function fetchMetadata(registry, pkg) {
  let response;
  try {
    response = await fetch(metadataUrl(registry, pkg.name), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    return {
      pkg,
      problem: `registry request failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (response.status === 404) return { pkg, missingName: true };
  if (!response.ok) return { pkg, problem: `registry returned HTTP ${response.status}` };

  try {
    return { pkg, metadata: await response.json() };
  } catch {
    return { pkg, problem: "registry returned invalid JSON" };
  }
}

async function inspect(registry, packages) {
  return Promise.all(packages.map((pkg) => fetchMetadata(registry, pkg)));
}

function reportProblems(results) {
  const problems = results.filter((result) => result.problem !== undefined);
  if (problems.length === 0) return;
  fail(
    `could not inspect npm metadata:\n${problems
      .map(({ pkg, problem }) => `- ${pkg.name}: ${problem}`)
      .join("\n")}`
  );
}

async function checkNames(args, packages) {
  const results = await inspect(args.registry, packages);
  reportProblems(results);
  const missing = results.filter((result) => result.missingName).map(({ pkg }) => pkg.name);

  if (missing.length > 0) {
    fail(
      [
        `${missing.length} public workspace package name(s) do not exist on npm:`,
        ...missing.map((name) => `- ${name}`),
        "",
        "OIDC trusted publishing is configured per existing npm package.",
        "Bootstrap each new package with maintainer credentials, configure its trusted publisher",
        "for .github/workflows/release-packages.yml, then rerun the release."
      ].join("\n")
    );
  }

  console.log(`npm package-name preflight passed (${packages.length} publishable packages)`);
}

function missingVersions(results) {
  return results
    .filter(
      ({ pkg, metadata, missingName }) =>
        missingName === true ||
        metadata?.versions === undefined ||
        metadata.versions[pkg.version] === undefined
    )
    .map(({ pkg }) => `${pkg.name}@${pkg.version}`);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function checkVersions(args, packages) {
  let missing = [];
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    const results = await inspect(args.registry, packages);
    reportProblems(results);
    missing = missingVersions(results);
    if (missing.length === 0) {
      console.log(
        `npm release completeness check passed (${packages.length} packages at exact workspace versions)`
      );
      return;
    }
    if (attempt < args.attempts) {
      console.warn(
        `npm release is incomplete (${missing.length} package version(s) missing; attempt ${attempt}/${args.attempts}); retrying in ${args.delayMs}ms`
      );
      await sleep(args.delayMs);
    }
  }

  fail(
    `npm release is incomplete after ${args.attempts} attempt(s):\n${missing
      .map((entry) => `- ${entry}`)
      .join("\n")}`
  );
}

try {
  const args = parseArgs(process.argv.slice(2));
  const packages = publishablePackages(args.root);
  if (args.mode === "names") await checkNames(args, packages);
  else await checkVersions(args, packages);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
