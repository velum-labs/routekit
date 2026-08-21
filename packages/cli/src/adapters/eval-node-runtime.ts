import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import { packageRootFromEntry } from "../self-update/candidate.js";
import { readInstallerReceipt } from "../self-update/receipt.js";

const ROUTEKIT_NODE_VERSION = "22.22.2";
const MINIMUM_NODE_VERSION = [22, 22, 0] as const;

const platformName = (platform: NodeJS.Platform): "darwin" | "linux" | undefined =>
  platform === "darwin" || platform === "linux" ? platform : undefined;

const architectureName = (architecture: NodeJS.Architecture): "arm64" | "x64" | undefined =>
  architecture === "arm64" || architecture === "x64" ? architecture : undefined;

const supportedNodeVersion = (raw: string): boolean => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(raw.trim());
  if (match === null) return false;
  const observed = match.slice(1, 4).map(Number);
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    const difference = observed[index]! - MINIMUM_NODE_VERSION[index]!;
    if (difference !== 0) return difference > 0;
  }
  return true;
};

const executableNodeVersion = (execPath: string): string | undefined => {
  try {
    accessSync(execPath, constants.X_OK);
    return execFileSync(execPath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000
    }).trim();
  } catch {
    return undefined;
  }
};

export interface EvalNodeRuntimeResolutionInput {
  readonly architecture: NodeJS.Architecture;
  readonly currentExecPath: string;
  readonly currentVersion: string;
  readonly entry?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

/**
 * Resolve the supported Node runtime used by both qualification dry-load and
 * execution.
 *
 * A RouteKit CLI launched through an npm `#!/usr/bin/env node` shim can inherit
 * an older Node from the embedding T3 shell even when the pinned RouteKit Node
 * runtime is installed. Node exits 9 on the first unsupported node:test flag,
 * before loading the generated suite. Prefer the current runtime when valid,
 * then the installer receipt, private runtime, T3 `/opt` runtime, and PATH.
 */
export const resolveEvalNodeExecPath = (
  input: EvalNodeRuntimeResolutionInput = {
    architecture: globalThis.process.arch,
    currentExecPath: globalThis.process.execPath,
    currentVersion: globalThis.process.versions.node,
    entry: globalThis.process.argv[1],
    env: globalThis.process.env,
    platform: globalThis.process.platform
  }
): string => {
  if (supportedNodeVersion(input.currentVersion)) return input.currentExecPath;

  const platform = platformName(input.platform);
  const architecture = architectureName(input.architecture);
  const packageRoot = input.entry === undefined ? undefined : packageRootFromEntry(input.entry);
  const receipt = packageRoot === undefined ? undefined : readInstallerReceipt(packageRoot);
  const runtimeName =
    platform === undefined || architecture === undefined
      ? undefined
      : `node-v${ROUTEKIT_NODE_VERSION}-${platform}-${architecture}`;
  const candidates = [
    input.env.ROUTEKIT_NODE_EXECUTABLE,
    receipt?.receipt.nodeExecutable,
    runtimeName === undefined || input.env.HOME === undefined
      ? undefined
      : join(input.env.HOME, ".local", "share", "routekit", "node", runtimeName, "bin", "node"),
    runtimeName === undefined ? undefined : join("/opt", runtimeName, "bin", "node"),
    ...(input.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "node"))
  ].filter((candidate): candidate is string => candidate !== undefined);

  for (const candidate of [...new Set(candidates)]) {
    const version = executableNodeVersion(candidate);
    if (version !== undefined && supportedNodeVersion(version)) return candidate;
  }
  throw new Error(
    `RouteKit Eval requires Node >= ${MINIMUM_NODE_VERSION.join(".")}; ` +
      `the CLI is running under ${input.currentVersion}.`
  );
};
