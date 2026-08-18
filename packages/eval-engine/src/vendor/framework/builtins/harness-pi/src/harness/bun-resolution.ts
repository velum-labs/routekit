// PATH resolution for the `pi` script, the Node that runs it, and `npm` for
// its installs.
//
// `pi` is a Node-shebang CLI. Spawning `node <script>` treats the script
// argument as a filesystem path — it does not PATH-resolve a bare command
// name — so a missing `pi` degrades to the bare name and the harness's normal
// "not found" diagnostic surfaces. The same search locates `npm` for the
// pinned pi runtime and extension SDK installs (`npm install --ignore-scripts`).

import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

// Bundle-wide `--define` injected by the compile step (`ORI_CLI_COMPILED=true`
// when compiling a single-file binary, `false` otherwise). Declared ambient
// here — mirroring `@ori-runtime/cli/build-info` — rather than imported,
// because a builtin must not depend on the CLI layer (RFC 0002: builtins are
// user-space features). In source/test runs (no compile step) the identifier
// is absent, so the `typeof` guard resolves it to `false` without throwing.
declare const ORI_CLI_COMPILED: boolean | undefined;

const EMPTY_COUNT = 0;
const NODE_BINARY_NAME = "node";
const NPM_BINARY_NAME = "npm";

// Kept local (not imported from build-info) to preserve the builtin → CLI
// non-dependency; the underlying `ORI_CLI_COMPILED` define is the same one
// build-info reads. Wave 2 sets the define false for this product.
export const isCompiledOriBuild = (): boolean =>
  typeof ORI_CLI_COMPILED === "boolean" && ORI_CLI_COMPILED;

export const resolveExecutablePath = async (
  binary: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> => {
  if (isAbsolute(binary) || binary.includes("/")) {
    return binary;
  }
  const entries = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length !== EMPTY_COUNT);
  for (const entry of entries) {
    const candidate = join(entry, binary);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not executable here; keep searching the remaining PATH entries.
    }
  }
  return undefined;
};

// The Node that runs `pi`: this process's interpreter (ori is itself Node),
// else a PATH `node`, else the bare name so the spawn site's diagnostic fires.
export const resolveNodeBinary = async (
  env: NodeJS.ProcessEnv
): Promise<string> => {
  if (process.execPath !== "") {
    return process.execPath;
  }
  return (await resolveExecutablePath(NODE_BINARY_NAME, env)) ?? NODE_BINARY_NAME;
};

// PATH-first `npm` for pi-runtime and extension SDK installs. A missing `npm`
// degrades to the bare name so the install failure names what was spawned.
export const resolveNpm = async (env: NodeJS.ProcessEnv): Promise<string> =>
  (await resolveExecutablePath(NPM_BINARY_NAME, env)) ?? NPM_BINARY_NAME;
