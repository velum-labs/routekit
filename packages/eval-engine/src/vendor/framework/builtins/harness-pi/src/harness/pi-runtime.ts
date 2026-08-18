// Runtime selection for the `pi` subprocess.
//
// `pi` ships as a Node-shebang (`#!/usr/bin/env node`) CLI. This product runs
// on Node, so the harness always spawns
// `<node> <realpath(pi-cli.js)> ...` — `process.execPath` when ori is already
// running under Node, otherwise a PATH-resolved `node`.
//
// On Node >= 23 the native ESM loader's `legacyMainResolve` rejects `pi`'s
// own `main`-without-`exports` dependencies (e.g. `cross-spawn@7`) with
// `ERR_MODULE_NOT_FOUND`, even though Node 25 nominally satisfies `pi`'s
// declared `engines.node` (">=22.19.0") — so a version-range check would not
// catch it. That remains a known risk (see WAVE0.md); engines stay without an
// upper cap.
//
// A user-provided `pi` (ORI_PI_BIN, or a global install) is commonly a bin
// **symlink** (e.g. `.../bin/pi` → `.../pi-coding-agent/dist/cli.js`).
// `pi`'s `dist/cli.js` does bare relative imports (`import { APP_NAME } from
// "./config.js"`), so its module base MUST be the real `dist/` directory.
// Node resolves symlinks by default (`--preserve-symlinks` is off); handing
// Node the realpath'd target instead of the symlink gives it that module base.
//
// Note: a `Cannot find module './config.js' from '/.l2s/.l2s.cli.js…'` crash
// is not a Node mechanism. `/.l2s/` paths come from proot-distro's
// link2symlink extension (Android/Termux hard-link emulation): some global
// installs hardlink files out of a cache, proot renames the real file to
// `/.l2s/.l2s.<name>NNNN`, and realpath then lands on that bare file with no
// `config.js` sibling. No spawn-side rewrite can fix such an install — the
// harness avoids it by copy-installing its own pi (`pi-install.ts`) and
// surfaces the l2s stderr hint below for user overrides.
//
// realpath is best-effort: on any failure (path missing, permissions) we
// return the input unchanged so the caller still spawns something and the
// harness's normal diagnostics surface, rather than throwing here.

import { realpath } from "node:fs/promises";

import {
  resolveExecutablePath,
  resolveNodeBinary,
} from "./bun-resolution.ts";

// Env var that pins the `pi` binary (owned by `harness.ts`). Referenced only in
// the l2s hint text; kept as a local literal to preserve the builtin →
// CLI/harness-config non-dependency (RFC 0002), mirroring the same value in
// `harness.ts`.
const ORI_PI_BIN_ENV = "ORI_PI_BIN";
const PI_RUNTIME_NODE = "node";

type PiRuntime = typeof PI_RUNTIME_NODE;

const canonicalizePiScript = async (piPath: string): Promise<string> => {
  try {
    return await realpath(piPath);
  } catch {
    return piPath;
  }
};

interface PiInvocation {
  readonly binary: string;
  readonly args: readonly string[];
  // Always `node` — downstream hint logic keys off this so the
  // ERR_MODULE_NOT_FOUND hint still fires.
  readonly effectiveRuntime: PiRuntime;
}

const resolvePiInvocation = async (input: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}): Promise<PiInvocation> => {
  const { args, binary, env } = input;
  const node = await resolveNodeBinary(env);
  const resolved = (await resolveExecutablePath(binary, env)) ?? binary;
  const script = await canonicalizePiScript(resolved);
  return {
    args: [script, ...args],
    binary: node,
    effectiveRuntime: PI_RUNTIME_NODE,
  };
};

// proot-distro's link2symlink hard-link emulation (Android/Termux) mangling a
// hardlink-installed pi: the script realpath-resolves into `/.l2s/`, where its
// relative imports (`./config.js`) have no siblings. The harness's own
// copy-installed pi (pi-install.ts) never hits this; the signature only
// surfaces for a user override pointing at a hardlink-installed pi. Checked
// before the Node hint because this stderr also matches `Cannot find module`.
const L2S_PATH_PATTERN = /\/\.l2s\//u;
const PI_L2S_HINT = `This looks like proot's link2symlink hard-link emulation (Android/Termux proot-distro) mangling a hardlink-installed pi: the script resolves into /.l2s/ where its relative imports cannot resolve. ori self-heals by keeping its own copy-installed pi under ~/.ori/pi-runtime — unset ${ORI_PI_BIN_ENV} to use it, or point ${ORI_PI_BIN_ENV} at a pi installed with \`npm install --ignore-scripts\`.`;

// A Node ESM module-resolution failure inside `pi`'s own dependency graph. On
// Node >= 23 the native loader's `legacyMainResolve` rejects `main`-without-
// `exports` packages that `pi` depends on, crashing `pi` at startup with this
// code before any session output.
const NODE_MODULE_NOT_FOUND_PATTERN =
  /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/u;
const PI_RUNTIME_HINT = `This looks like a Node module-resolution failure inside pi itself (seen on Node >= 23). Run pi under Node 22.`;

// Append a runtime-specific hint to a pi failure message:
//   * An `/.l2s/` path in the stderr → the proot link2symlink hint. Checked
//     FIRST: the l2s stderr also matches `NODE_MODULE_NOT_FOUND_PATTERN`, and
//     the Node>=23 hint would misdiagnose it (switching Node versions cannot
//     fix a mangled install).
//   * A Node module-resolution signature → the Node 22 hint.
const withRuntimeHint = (
  message: string,
  effectiveRuntime: PiRuntime,
  rawStderr: string
): string => {
  if (L2S_PATH_PATTERN.test(rawStderr)) {
    return `${message} ${PI_L2S_HINT}`;
  }
  if (
    effectiveRuntime === PI_RUNTIME_NODE &&
    NODE_MODULE_NOT_FOUND_PATTERN.test(rawStderr)
  ) {
    return `${message} ${PI_RUNTIME_HINT}`;
  }
  return message;
};

export { resolvePiInvocation, withRuntimeHint };
export type { PiRuntime };
