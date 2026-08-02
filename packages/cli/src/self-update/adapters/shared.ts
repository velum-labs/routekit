import { existsSync } from "node:fs";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";

import {
  canonicalPath,
  enumerateExecutables,
  findExecutablesInDirectory
} from "../candidate.js";
import {
  npmPrefixFromPackageRoot,
  privateRuntimeNpmCandidates,
  readInstallerReceipt
} from "../receipt.js";
import { lastOutputLine } from "../runner.js";
import type { DiscoveryContext } from "../types.js";

function executableBasename(path: string): string {
  return basename(path).replace(/\.(?:cmd|exe|bat)$/i, "").toLowerCase();
}

function addExecutable(values: string[], value: string | undefined, expected: string): void {
  if (value === undefined || !existsSync(value) || executableBasename(value) !== expected) return;
  const canonical = canonicalPath(value);
  if (!values.some((candidate) => canonicalPath(candidate) === canonical)) values.push(value);
}

function addEnvironmentExecutable(
  values: string[],
  value: string | undefined,
  expected: "npm" | "pnpm" | "yarn" | "bun"
): void {
  if (value === undefined || !existsSync(value)) return;
  const basenameValue = basename(value).toLowerCase();
  const accepted =
    executableBasename(value) === expected ||
    basenameValue === `${expected}-cli.js` ||
    (expected === "pnpm" && (basenameValue === "pnpm.cjs" || basenameValue === "pnpm.js")) ||
    (expected === "yarn" && (basenameValue === "yarn.js" || basenameValue === "yarn.cjs"));
  if (!accepted) return;
  const canonical = canonicalPath(value);
  if (!values.some((candidate) => canonicalPath(candidate) === canonical)) values.push(value);
}

function pathInside(value: string, parent: string): boolean {
  const normalizedValue = normalize(resolve(value));
  const normalizedParent = normalize(resolve(parent));
  return (
    normalizedValue === normalizedParent ||
    normalizedValue.startsWith(`${normalizedParent}${process.platform === "win32" ? "\\" : "/"}`)
  );
}

function pnpmHomeFromPackage(packageRoot: string): string | undefined {
  const normalized = normalize(resolve(packageRoot));
  const marker = `${process.platform === "win32" ? "\\" : "/"}global${
    process.platform === "win32" ? "\\" : "/"
  }`;
  const index = normalized.lastIndexOf(marker);
  return index > 0 ? normalized.slice(0, index) : undefined;
}

function bunHomeFromPackage(packageRoot: string): string | undefined {
  const normalized = normalize(resolve(packageRoot));
  const marker = `${sep}install${sep}global${sep}`;
  const index = normalized.lastIndexOf(marker);
  return index > 0 ? normalized.slice(0, index) : undefined;
}

function voltaHomeFromPackage(packageRoot: string): string | undefined {
  const normalized = normalize(resolve(packageRoot));
  const marker = `${sep}tools${sep}image${sep}packages${sep}`;
  const index = normalized.lastIndexOf(marker);
  return index > 0 ? normalized.slice(0, index) : undefined;
}

function addProcessSibling(
  values: string[],
  name: "npm" | "pnpm" | "yarn" | "bun" | "volta",
  context: DiscoveryContext
): void {
  for (const candidate of findExecutablesInDirectory(
    name,
    dirname(context.processExecPath),
    context.platform
  )) {
    addExecutable(values, candidate, name);
  }
}

export function managerExecutables(
  name: "npm" | "pnpm" | "yarn" | "bun" | "volta",
  context: DiscoveryContext
): string[] {
  const values: string[] = [];
  for (const candidate of enumerateExecutables(name, context.pathValue, context.platform))
    addExecutable(values, candidate, name);
  addProcessSibling(values, name, context);
  if (name !== "volta") {
    const agent = context.env.npm_config_user_agent?.split("/", 1)[0]?.toLowerCase();
    if (agent === name) addEnvironmentExecutable(values, context.env.npm_execpath, name);
  }

  if (name === "npm") {
    const npmPrefix = npmPrefixFromPackageRoot(context.packageRoot);
    addExecutable(values, npmPrefix && join(npmPrefix, "bin", "npm"), name);
    const receipt = readInstallerReceipt(context.packageRoot);
    addExecutable(values, receipt?.receipt.npmExecutable, name);
    for (const candidate of privateRuntimeNpmCandidates(context.packageRoot, context.env))
      addExecutable(values, candidate, name);
  }
  if (name === "pnpm") {
    if (
      context.env.PNPM_HOME !== undefined &&
      pathInside(context.packageRoot, context.env.PNPM_HOME)
    )
      addExecutable(values, join(context.env.PNPM_HOME, "pnpm"), name);
    const inferred = pnpmHomeFromPackage(context.packageRoot);
    addExecutable(values, inferred && join(inferred, "pnpm"), name);
    addExecutable(values, inferred && join(inferred, "bin", "pnpm"), name);
  }
  if (name === "bun") {
    if (
      context.env.BUN_INSTALL !== undefined &&
      pathInside(context.packageRoot, context.env.BUN_INSTALL)
    )
      addExecutable(values, join(context.env.BUN_INSTALL, "bin", "bun"), name);
    const inferred = bunHomeFromPackage(context.packageRoot);
    addExecutable(values, inferred && join(inferred, "bin", "bun"), name);
  }
  if (name === "volta") {
    if (
      context.env.VOLTA_HOME !== undefined &&
      pathInside(context.packageRoot, context.env.VOLTA_HOME)
    )
      addExecutable(values, join(context.env.VOLTA_HOME, "bin", "volta"), name);
    const inferred = voltaHomeFromPackage(context.packageRoot);
    addExecutable(values, inferred && join(inferred, "bin", "volta"), name);
  }
  return values;
}

export async function outputLine(
  context: DiscoveryContext,
  executable: string,
  args: readonly string[]
): Promise<string | undefined> {
  return await lastOutputLine(context.runner, executable, args, context.env, {
    cwd: context.neutralCwd,
    operation: "probe"
  });
}

export function contextId(kind: string, ...paths: string[]): string {
  return `${kind}:${paths.map(canonicalPath).join(":")}`;
}

export function versionMajor(value: string): number | undefined {
  const major = Number.parseInt(value.replace(/^v/, "").split(".", 1)[0] ?? "", 10);
  return Number.isFinite(major) ? major : undefined;
}

export async function verifyDetectedOwner<Owner extends { contextId: string }>(
  owner: Owner,
  context: DiscoveryContext,
  detect: (context: DiscoveryContext) => Promise<Owner[]>
): Promise<Owner | undefined> {
  return (await detect(context)).find((candidate) => candidate.contextId === owner.contextId);
}
