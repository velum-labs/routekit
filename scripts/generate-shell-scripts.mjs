/**
 * Generate TypeScript string constants from shell/*.sh sources.
 *
 * Source of truth: shell/lib/*.sh and shell/remote/*.sh. Each remote script
 * may begin with `# include <relative-path>` directives that are expanded
 * in-place (no trailing newline on the final resolved program, matching the
 * historical string-array join).
 *
 * Outputs:
 *   - packages/cli/src/generated/shell-scripts.ts
 *   - install.sh (flattened public installer, when shell/install.sh exists)
 *
 * Run `node scripts/generate-shell-scripts.mjs` after editing any shell/
 * file; `--check` verifies the generated files are current (used by pnpm check).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shellRoot = join(root, "shell");
const checkMode = process.argv.includes("--check");

const HEADER_NOTE =
  "GENERATED FILE - DO NOT EDIT. Source of truth: shell/**/*.sh. " +
  "Regenerate with `node scripts/generate-shell-scripts.mjs`.";

/** Strip a single trailing newline so join composition stays byte-identical. */
function stripTrailingNewline(text) {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * Expand `# include <path>` directives relative to `shell/`. Includes are
 * resolved recursively; cycles and missing files fail the generator.
 */
function resolveScript(relativePath, stack = []) {
  const abs = join(shellRoot, relativePath);
  const key = relative(shellRoot, abs);
  if (stack.includes(key)) {
    throw new Error(`include cycle: ${[...stack, key].join(" -> ")}`);
  }
  if (!existsSync(abs)) {
    throw new Error(`missing shell source: ${relativePath}`);
  }
  const raw = stripTrailingNewline(readFileSync(abs, "utf8"));
  const lines = raw.split("\n");
  const out = [];
  for (const line of lines) {
    const match = /^# include (.+)$/.exec(line);
    if (match === null) {
      out.push(line);
      continue;
    }
    const includePath = match[1].trim();
    out.push(resolveScript(includePath, [...stack, key]));
  }
  return out.join("\n");
}

function sha256Prefixed(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function apply(path, content) {
  if (checkMode) {
    if (!existsSync(path)) {
      console.error(`shell scripts check failed: missing generated file ${path}`);
      process.exitCode = 1;
      return;
    }
    const current = readFileSync(path, "utf8");
    if (current !== content) {
      console.error(
        `shell scripts check failed: ${relative(root, path)} is stale; ` +
          "run `node scripts/generate-shell-scripts.mjs`"
      );
      process.exitCode = 1;
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote ${relative(root, path)}`);
}

const EXPORTS = [
  ["REMOTE_PATH_PREAMBLE", "lib/preamble.sh"],
  ["PROBE_SCRIPT", "remote/probe.sh"],
  ["INSTALL_SCRIPT", "remote/install.sh"],
  ["CONFIG_INIT_SCRIPT", "remote/config-init.sh"],
  ["STATUS_SCRIPT", "remote/status.sh"],
  ["START_SCRIPT", "remote/start.sh"],
  ["RELAY_SCRIPT", "remote/relay.sh"],
  ["PEER_ADD_SCRIPT", "remote/peer-add.sh"]
];

const resolved = new Map();
for (const [name, path] of EXPORTS) {
  resolved.set(name, resolveScript(path));
}

// Optional public installer body (Phase 2+). When present it is flattened into
// install.sh at the repo root and also exported as INSTALLER_SCRIPT.
const installerSource = join(shellRoot, "install.sh");
if (existsSync(installerSource)) {
  resolved.set("INSTALLER_SCRIPT", resolveScript("install.sh"));
}

const digests = {};
for (const [name, text] of resolved) {
  digests[name] = sha256Prefixed(text);
}

function renderTs() {
  const parts = [`// ${HEADER_NOTE}`, ""];
  for (const [name] of EXPORTS) {
    parts.push(`export const ${name} = ${JSON.stringify(resolved.get(name))};`);
    parts.push("");
  }
  if (resolved.has("INSTALLER_SCRIPT")) {
    parts.push(
      `export const INSTALLER_SCRIPT = ${JSON.stringify(resolved.get("INSTALLER_SCRIPT"))};`
    );
    parts.push("");
  }
  parts.push(
    `export const SHELL_SCRIPT_DIGESTS = ${JSON.stringify(digests, null, 2)} as const;`
  );
  parts.push("");
  return parts.join("\n");
}

apply(join(root, "packages/cli/src/generated/shell-scripts.ts"), renderTs());

if (resolved.has("INSTALLER_SCRIPT")) {
  // Public one-liner body: ensure a trailing newline for the release asset.
  apply(join(root, "install.sh"), `${resolved.get("INSTALLER_SCRIPT")}\n`);
}

if (checkMode && process.exitCode === undefined) {
  console.log("shell scripts check passed");
}
