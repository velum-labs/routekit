#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCorepackPnpmSync } from "./lib/corepack-pnpm.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const wrapperPath = resolve(scriptDir, "routekit-dev.mjs");
const dryRun = process.argv.includes("--dry-run");

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizePath(value) {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function findCommandsOnPath(command) {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const matches = [];
  const seen = new Set();

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = resolve(
        entry,
        process.platform === "win32" ? `${command}${extension.toLowerCase()}` : command
      );
      const normalized = normalizePath(candidate);
      if (existsSync(candidate) && !seen.has(normalized)) {
        matches.push(candidate);
        seen.add(normalized);
      }
    }
  }

  return matches;
}

function findCommandOnPath(command) {
  return findCommandsOnPath(command).at(0) ?? null;
}

function readGlobalBinDir() {
  const result = spawnCorepackPnpmSync(["bin", "-g"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });

  if (result.error !== undefined) {
    throw new Error(`could not run \`corepack pnpm bin -g\`: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim();
    throw new Error(output === "" ? "`corepack pnpm bin -g` failed" : output);
  }

  const binDir = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => isAbsolute(line))
    .at(-1);
  if (binDir === undefined) {
    const output = result.stdout.trim();
    throw new Error(
      output === ""
        ? "`corepack pnpm bin -g` returned an empty path"
        : `could not find an absolute global bin path in output: ${output}`
    );
  }
  return binDir;
}

function unixShimContents() {
  return `#!/bin/sh
exec node ${shellQuote(wrapperPath)} "$@"
`;
}

function windowsShimContents() {
  return `@echo off
node "${wrapperPath}" %*
`;
}

function writeUnixShimAt(target, message) {
  if (dryRun) {
    console.log(`would write ${target}`);
    return target;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, unixShimContents(), { mode: 0o755 });
  chmodSync(target, 0o755);
  console.log(message);
  return target;
}

function writeUnixShim(binDir) {
  const target = resolve(binDir, "routekit-dev");
  return writeUnixShimAt(target, `linked routekit-dev -> ${wrapperPath}`);
}

function writeWindowsShim(binDir) {
  const cmdTarget = resolve(binDir, "routekit-dev.cmd");
  const shellTarget = resolve(binDir, "routekit-dev");

  if (dryRun) {
    console.log(`would write ${cmdTarget}`);
    console.log(`would write ${shellTarget}`);
    return cmdTarget;
  }

  mkdirSync(binDir, { recursive: true });
  writeFileSync(cmdTarget, windowsShimContents());
  writeFileSync(shellTarget, unixShimContents(), { mode: 0o755 });
  chmodSync(shellTarget, 0o755);
  console.log(`linked routekit-dev -> ${wrapperPath}`);
  return cmdTarget;
}

function isGeneratedRoutekitDevShim(contents) {
  const normalized = contents.replaceAll("\\", "/").replaceAll("\r\n", "\n").trimEnd();
  const lines = normalized.split("\n");

  if (lines.length === 2 && lines[0] === "#!/bin/sh") {
    return (
      lines[1].startsWith("exec node ") &&
      lines[1].endsWith(' "$@"') &&
      lines[1].includes("/scripts/routekit-dev.mjs")
    );
  }

  return (
    lines.length === 2 &&
    lines[0].toLowerCase() === "@echo off" &&
    lines[1].startsWith('node "') &&
    lines[1].endsWith('" %*') &&
    lines[1].includes("/scripts/routekit-dev.mjs")
  );
}

function reconcileGeneratedShims(target) {
  for (const candidate of findCommandsOnPath("routekit-dev")) {
    if (normalizePath(candidate) === normalizePath(target)) continue;

    let contents;
    try {
      contents = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    if (!isGeneratedRoutekitDevShim(contents)) continue;

    const desired =
      process.platform === "win32" && candidate.toLowerCase().endsWith(".cmd")
        ? windowsShimContents()
        : unixShimContents();
    if (contents === desired) continue;

    if (dryRun) {
      console.log(`would update stale routekit-dev shim at ${candidate}`);
      continue;
    }

    if (process.platform === "win32" && candidate.toLowerCase().endsWith(".cmd")) {
      writeFileSync(candidate, desired);
    } else {
      writeFileSync(candidate, desired, { mode: 0o755 });
      chmodSync(candidate, 0o755);
    }
    console.log(`updated stale routekit-dev shim at ${candidate} -> ${wrapperPath}`);
  }
}

function warnIfShadowed(target) {
  const resolved = findCommandOnPath("routekit-dev");
  if (resolved === null) {
    console.warn(
      `warning: ${dirname(target)} is not on PATH, so \`routekit-dev\` will not resolve yet.`
    );
    return;
  }

  if (normalizePath(resolved) !== normalizePath(target)) {
    console.warn(`warning: \`routekit-dev\` currently resolves to ${resolved}`);
    console.warn(`warning: put ${dirname(target)} earlier on PATH to use ${target}`);
  }
}

if (!existsSync(wrapperPath)) {
  console.error(`routekit-dev link failed: missing wrapper at ${wrapperPath}`);
  process.exit(1);
}

try {
  const binDir = readGlobalBinDir();
  const target = process.platform === "win32" ? writeWindowsShim(binDir) : writeUnixShim(binDir);
  reconcileGeneratedShims(target);

  if (dryRun) {
    console.log(`global pnpm bin directory: ${binDir}`);
    console.log(`source checkout: ${repoRoot}`);
  } else {
    warnIfShadowed(target);
    console.log("run `routekit-dev --version` from any directory to verify the link.");
    console.log("if this shell cached another checkout, run `rehash` (zsh) or `hash -r` (bash).");
  }
} catch (error) {
  console.error(
    `routekit-dev link failed: ${error instanceof Error ? error.message : String(error)}`
  );
  console.error("Make sure Corepack is available and pnpm's global bin directory is configured.");
  process.exit(1);
}
