import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function pathEnvironmentKey(environment) {
  return Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function writePnpmShim(directory) {
  const shellTarget = join(directory, "pnpm");
  const shellContents = `#!/bin/sh
exec corepack pnpm "$@"
`;

  writeFileSync(shellTarget, shellContents, { mode: 0o755 });
  chmodSync(shellTarget, 0o755);

  if (process.platform === "win32") {
    writeFileSync(join(directory, "pnpm.cmd"), "@echo off\r\ncorepack pnpm %*\r\n");
  }
}

export function createCorepackPnpmEnvironment(baseEnvironment = process.env) {
  const shimDirectory = mkdtempSync(join(tmpdir(), "routekit-corepack-pnpm-"));
  writePnpmShim(shimDirectory);

  const environment = { ...baseEnvironment };
  const pathKey = pathEnvironmentKey(environment);
  environment[pathKey] = [shimDirectory, environment[pathKey]].filter(Boolean).join(delimiter);

  return {
    environment,
    shimDirectory,
    dispose() {
      rmSync(shimDirectory, { force: true, recursive: true });
    }
  };
}

export function spawnCorepackPnpmSync(arguments_, options = {}) {
  const pinned = createCorepackPnpmEnvironment(options.env ?? process.env);

  try {
    return spawnSync(commandName("corepack"), ["pnpm", ...arguments_], {
      ...options,
      env: pinned.environment
    });
  } finally {
    pinned.dispose();
  }
}
