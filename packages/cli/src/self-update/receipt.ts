import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { packageRootFromEntry, samePath, shimTarget } from "./candidate.js";
import { ROUTEKIT_PACKAGE_NAME } from "./types.js";

export type InstallerReceipt = {
  schemaVersion: 1;
  provenance: "routekit-installer";
  manager: "npm";
  packageName: typeof ROUTEKIT_PACKAGE_NAME;
  prefix: string;
  npmExecutable: string;
  nodeExecutable: string;
  routekitExecutable: string;
  installMode: "system" | "private";
};

export function npmPrefixFromPackageRoot(packageRoot: string): string | undefined {
  const normalized = resolve(packageRoot);
  const marker = `${join("lib", "node_modules")}${process.platform === "win32" ? "\\" : "/"}`;
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  return normalized.slice(0, index).replace(/[\\/]$/, "");
}

export function installerReceiptPath(prefix: string): string {
  return join(prefix, "lib", "routekit", "install.json");
}

function isReceipt(value: unknown): value is InstallerReceipt {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as Partial<InstallerReceipt>;
  return (
    receipt.schemaVersion === 1 &&
    receipt.provenance === "routekit-installer" &&
    receipt.manager === "npm" &&
    receipt.packageName === ROUTEKIT_PACKAGE_NAME &&
    typeof receipt.prefix === "string" &&
    typeof receipt.npmExecutable === "string" &&
    typeof receipt.nodeExecutable === "string" &&
    typeof receipt.routekitExecutable === "string" &&
    (receipt.installMode === "system" || receipt.installMode === "private")
  );
}

export function readInstallerReceipt(packageRoot: string):
  | {
      path: string;
      receipt: InstallerReceipt;
    }
  | undefined {
  const prefix = npmPrefixFromPackageRoot(packageRoot);
  if (prefix === undefined) return undefined;
  const path = installerReceiptPath(prefix);
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isReceipt(value) || !samePath(value.prefix, prefix)) return undefined;
    let receiptRoot: string | undefined;
    try {
      receiptRoot = packageRootFromEntry(shimTarget(value.routekitExecutable));
    } catch {
      receiptRoot = undefined;
    }
    if (receiptRoot === undefined || !samePath(receiptRoot, packageRoot)) return undefined;
    return { path, receipt: value };
  } catch {
    return undefined;
  }
}

export function privateRuntimeNpmCandidates(packageRoot: string, env: NodeJS.ProcessEnv): string[] {
  const prefix = npmPrefixFromPackageRoot(packageRoot);
  const home = env.HOME;
  if (prefix === undefined || home === undefined || !samePath(prefix, join(home, ".local")))
    return [];
  const nodeRoot = join(home, ".local", "share", "routekit", "node");
  if (!existsSync(nodeRoot)) return [];
  try {
    return [
      ...new Set(
        readdirSync(nodeRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith("node-v"))
          .map((entry) => join(nodeRoot, entry.name, "bin", "npm"))
          .filter(existsSync)
      )
    ];
  } catch {
    return [];
  }
}

export function isPrivateInstallerNpm(
  executable: string,
  prefix: string,
  env: NodeJS.ProcessEnv
): boolean {
  const home = env.HOME;
  if (home === undefined || !samePath(prefix, join(home, ".local"))) return false;
  const expectedRoot = join(home, ".local", "share", "routekit", "node");
  return resolve(executable).startsWith(`${resolve(expectedRoot)}${sep}`);
}

export function writeInstallerReceipt(receipt: InstallerReceipt): string {
  const path = installerReceiptPath(receipt.prefix);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}

export function packageRootProject(packageRoot: string): string | undefined {
  const resolved = resolve(packageRoot);
  const parts = resolved.split(sep);
  const nodeModules = parts.lastIndexOf("node_modules");
  if (nodeModules > 0) {
    return parts.slice(0, nodeModules).join(sep) || sep;
  }
  let current = dirname(resolved);
  while (current !== dirname(current)) {
    if (existsSync(join(current, "package.json"))) return current;
    current = dirname(current);
  }
  return undefined;
}
