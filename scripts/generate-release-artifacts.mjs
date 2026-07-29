#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { buildReleaseArtifacts, RELEASE_ROOT_PACKAGE } from "./lib/release-artifacts.mjs";

function fail(message) {
  throw new Error(`generate-release-artifacts: ${message}`);
}

function parseArgs(argv) {
  const result = { outDir: "release-artifacts" };
  const names = {
    "--out-dir": "outDir",
    "--version": "version",
    "--source-sha": "sourceSha",
    "--generated-at": "generatedAt",
    "--registry": "registry"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (names[flag] === undefined || value === undefined) fail(`unknown or incomplete argument ${flag}`);
    result[names[flag]] = value;
    index += 1;
  }
  return result;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed\n${result.stderr?.trim() ?? ""}`);
  }
  return result.stdout;
}

function installPublishedCli({ version, directory, registry }) {
  writeFileSync(
    resolve(directory, "package.json"),
    `${JSON.stringify({ name: "routekit-release-artifact-root", version: "1.0.0", private: true }, null, 2)}\n`
  );
  const baseArgs = [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=true",
    "--prefer-online",
    "--fetch-retries=5",
    "--fetch-retry-mintimeout=10000",
    "--fetch-retry-maxtimeout=60000",
    "--fetch-timeout=300000",
    `${RELEASE_ROOT_PACKAGE}@${version}`
  ];
  if (registry) baseArgs.push("--registry", registry);
  // npm registry metadata can lag a successful trusted publish by several
  // minutes. Use a fresh cache for each attempt so an ETARGET response cannot
  // poison later attempts after the exact version has become visible.
  const delays = [0, 15_000, 30_000, 60_000, 120_000, 240_000];
  let lastError;
  for (const [index, delay] of delays.entries()) {
    if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    try {
      const args = [...baseArgs, "--cache", resolve(directory, `.npm-cache-${index}`)];
      run("npm", args, { cwd: directory });
      return;
    } catch (error) {
      lastError = error;
      const nextDelay = delays[index + 1];
      if (nextDelay !== undefined) {
        console.warn(
          `published CLI is not installable yet (attempt ${index + 1}/${delays.length}); retrying in ${
            nextDelay / 1_000
          }s`
        );
      }
    }
  }
  throw lastError;
}

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(new URL("../packages/cli/package.json", import.meta.url), "utf8"));
const expectedVersion = args.version ?? manifest.version;
if (manifest.version !== expectedVersion) fail(`expected CLI version ${expectedVersion}, found ${manifest.version}`);
const sourceSha = args.sourceSha ?? process.env.GITHUB_SHA ?? run("git", ["rev-parse", "HEAD"]).trim();
const generatedAt = args.generatedAt ?? new Date().toISOString();
const installDirectory = mkdtempSync(resolve(tmpdir(), "routekit-release-artifacts-"));
try {
  installPublishedCli({ version: expectedVersion, directory: installDirectory, registry: args.registry });
  let rawSpdx;
  try {
    rawSpdx = JSON.parse(
      run("npm", ["sbom", "--sbom-format", "spdx", "--sbom-type", "application", "--omit", "dev"], {
        cwd: installDirectory
      })
    );
  } catch (error) {
    fail(`could not generate npm SPDX output: ${error instanceof Error ? error.message : String(error)}`);
  }
  const artifacts = buildReleaseArtifacts({ spdx: rawSpdx, expectedVersion, sourceSha, generatedAt });
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });
  const prefix = `routekit-${expectedVersion}`;
  const sbomPath = resolve(outDir, `${prefix}.spdx.json`);
  const licensesPath = resolve(outDir, `${prefix}-licenses.json`);
  writeFileSync(sbomPath, `${JSON.stringify(artifacts.spdx, null, 2)}\n`);
  writeFileSync(licensesPath, `${JSON.stringify(artifacts.inventory, null, 2)}\n`);
  console.log(
    `release artifacts: ${artifacts.spdx.packages.length} SPDX packages; ${artifacts.inventory.summary.thirdPartyPackages} third-party packages; ${artifacts.inventory.summary.reviewedExceptions} reviewed license exceptions`
  );
  console.log(sbomPath);
  console.log(licensesPath);
} finally {
  rmSync(installDirectory, { recursive: true, force: true });
}
