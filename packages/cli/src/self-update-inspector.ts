import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";

import {
  type InstallVersionResolver,
  ROUTEKIT_PACKAGE_NAME,
  resolveInstallVersion
} from "./install-version.js";

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /(?:@velum-labs\/routekit\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

export type CommandResult = { stdout: string; stderr: string; exitCode: number };
export type CommandRunner = (
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
) => Promise<CommandResult>;

export type RouteKitCandidate = {
  path: string;
  entry: string;
  packageRoot: string;
  manifestVersion: string;
  executableVersion: string;
};

export type PackageOwner = {
  kind: "npm" | "pnpm";
  executable: string;
  packageRoot: string;
  prefix?: string;
  globalBin?: string;
  globalRoot?: string;
};

export type InstallationInspection = {
  originalPath: string;
  executing: RouteKitCandidate;
  pathCandidates: RouteKitCandidate[];
  owner: PackageOwner;
  command: readonly string[];
  diagnostics: readonly string[];
};

export type InspectOptions = {
  path?: string;
  env?: NodeJS.ProcessEnv;
  executingEntry?: string;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
};

export type SelfUpdateOptions = InspectOptions & {
  resolveVersion?: InstallVersionResolver;
};

export type SelfUpdateResult = {
  action: "planned" | "updated" | "skipped";
  from: string;
  to: string;
  version: string;
  targetVersion: string;
  owner: PackageOwner;
  command: readonly string[];
  diagnostics: readonly string[];
};

export class SelfUpdateInspectionError extends Error {
  /** Exact argv the user (or a follow-up run) should execute; never a shell string. */
  readonly remediation: readonly string[];
  readonly diagnostics: readonly string[];

  constructor(message: string, remediation: readonly string[], diagnostics: readonly string[]) {
    super(`${message}\nRemediation: ${remediation.join(" ")}`);
    this.name = "SelfUpdateInspectionError";
    this.remediation = remediation;
    this.diagnostics = diagnostics;
  }
}

const defaultRunner: CommandRunner = async (executable, args, env) => {
  try {
    const result = await execFileAsync(executable, [...args], {
      encoding: "utf8",
      env,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const candidate = error as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: candidate.stdout ?? "",
      stderr: candidate.stderr ?? "",
      exitCode: typeof candidate.code === "number" ? candidate.code : 1
    };
  }
};

function executableNames(name: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
}

function enumerateExecutables(
  name: string,
  pathValue: string,
  platform: NodeJS.Platform
): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const executable of executableNames(name, platform)) {
      const candidate = resolve(directory, executable);
      if (seen.has(normalize(candidate)) || !existsSync(candidate)) continue;
      try {
        if (!statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      seen.add(normalize(candidate));
      found.push(candidate);
      break;
    }
  }
  return found;
}

function packageManifest(root: string): { name?: unknown; version?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
  } catch {
    return undefined;
  }
}

function packageRootFromEntry(entry: string): string | undefined {
  let current = dirname(entry);
  for (;;) {
    const manifest = packageManifest(current);
    if (manifest?.name === ROUTEKIT_PACKAGE_NAME && typeof manifest.version === "string")
      return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function shimTarget(path: string): string {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // Continue with text-shim parsing below.
  }
  if (packageRootFromEntry(real) !== undefined) return real;
  // Windows npm shims and pnpm's POSIX shims are text launchers rather than
  // symlinks. Recognize only a RouteKit node_modules entry, never execute or
  // evaluate shim text.
  const source = readFileSync(path, "utf8");
  const match = source.match(
    /["']([^"'\r\n]*node_modules[\\/]@velum-labs[\\/]routekit[\\/](?:dist[\\/]index\.js|[^"'\r\n ]+))["']/i
  );
  if (match?.[1] === undefined) return real;
  const target = match[1]
    .replace(/%~dp0/gi, `${dirname(path)}\\`)
    .replace(/\$basedir/g, dirname(path));
  return normalize(isAbsolute(target) ? target : resolve(dirname(path), target));
}

function parseVersion(output: string): string | undefined {
  return output.trim().match(VERSION_PATTERN)?.[1];
}

async function inspectCandidate(
  path: string,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner
): Promise<RouteKitCandidate | undefined> {
  let entry: string;
  try {
    entry = shimTarget(path);
  } catch {
    return undefined;
  }
  const packageRoot = packageRootFromEntry(entry);
  if (packageRoot === undefined) return undefined;
  const manifest = packageManifest(packageRoot);
  if (typeof manifest?.version !== "string") return undefined;
  const result = await runner(path, ["version"], env);
  const executableVersion = result.exitCode === 0 ? parseVersion(result.stdout) : undefined;
  if (executableVersion === undefined) return undefined;
  return { path, entry, packageRoot, manifestVersion: manifest.version, executableVersion };
}

function samePath(left: string, right: string): boolean {
  const canonical = (value: string) => {
    try {
      return normalize(realpathSync(value));
    } catch {
      return normalize(resolve(value));
    }
  };
  return canonical(left) === canonical(right);
}

function packageLocations(root: string, prefix?: string): string[] {
  const locations = [join(root, "@velum-labs", "routekit")];
  if (prefix !== undefined)
    locations.push(join(prefix, "lib", "node_modules", "@velum-labs", "routekit"));
  return locations;
}

async function managerOutput(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  runner: CommandRunner
): Promise<string | undefined> {
  const result = await runner(executable, args, env);
  return result.exitCode === 0 && result.stdout.trim().length > 0
    ? result.stdout.trim().split(/\r?\n/).at(-1)?.trim()
    : undefined;
}

function pnpmListedPackageLocations(output: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return [];
  }
  const projects = Array.isArray(value) ? value : [value];
  const locations: string[] = [];
  for (const project of projects) {
    if (typeof project !== "object" || project === null) continue;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      const dependencies = Reflect.get(project, field);
      if (typeof dependencies !== "object" || dependencies === null) continue;
      const dependency = Reflect.get(dependencies, ROUTEKIT_PACKAGE_NAME);
      if (typeof dependency !== "object" || dependency === null) continue;
      const path = Reflect.get(dependency, "path");
      if (typeof path === "string") locations.push(path);
    }
  }
  return locations;
}

async function pnpmGlobalPackageLocations(
  executable: string,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner
): Promise<string[]> {
  const result = await runner(executable, ["list", "-g", "--depth", "0", "--json"], env);
  return result.exitCode === 0 ? pnpmListedPackageLocations(result.stdout) : [];
}

function sameOwnerContext(left: PackageOwner, right: PackageOwner): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "npm" && right.kind === "npm")
    return (
      left.prefix !== undefined &&
      right.prefix !== undefined &&
      samePath(left.prefix, right.prefix)
    );
  if (
    left.kind !== "pnpm" ||
    right.kind !== "pnpm" ||
    left.globalRoot === undefined ||
    right.globalRoot === undefined ||
    !samePath(left.globalRoot, right.globalRoot)
  )
    return false;
  if (left.globalBin === undefined || right.globalBin === undefined)
    return left.globalBin === right.globalBin;
  return samePath(left.globalBin, right.globalBin);
}

function addOwner(owners: PackageOwner[], owner: PackageOwner): void {
  if (!owners.some((candidate) => sameOwnerContext(candidate, owner))) owners.push(owner);
}

async function detectOwners(
  packageRoot: string,
  pathValue: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner
): Promise<PackageOwner[]> {
  const owners: PackageOwner[] = [];
  for (const executable of enumerateExecutables("npm", pathValue, platform)) {
    const prefix = await managerOutput(executable, ["prefix", "-g"], env, runner);
    const root = await managerOutput(executable, ["root", "-g"], env, runner);
    if (prefix === undefined || root === undefined) continue;
    if (packageLocations(root, prefix).some((location) => samePath(location, packageRoot))) {
      addOwner(owners, { kind: "npm", executable, packageRoot, prefix });
    }
  }
  for (const executable of enumerateExecutables("pnpm", pathValue, platform)) {
    const globalBin = await managerOutput(executable, ["bin", "-g"], env, runner);
    const globalRoot = await managerOutput(executable, ["root", "-g"], env, runner);
    if (globalRoot === undefined) continue;
    const locations = packageLocations(globalRoot);
    if (!locations.some((location) => samePath(location, packageRoot))) {
      locations.push(...(await pnpmGlobalPackageLocations(executable, env, runner)));
    }
    if (locations.some((location) => samePath(location, packageRoot))) {
      addOwner(owners, { kind: "pnpm", executable, packageRoot, globalBin, globalRoot });
    }
  }
  return owners;
}

export function remediationCommand(owner: PackageOwner | undefined, version: string): string[] {
  const specifier = `${ROUTEKIT_PACKAGE_NAME}@${version}`;
  if (owner?.kind === "npm") {
    return [owner.executable, "install", "-g", "--force", "--prefix", owner.prefix!, specifier];
  }
  if (owner?.kind === "pnpm") {
    return [owner.executable, "add", "-g", specifier];
  }
  return ["npm", "install", "-g", "--force", specifier];
}

function installCommand(owner: PackageOwner, version: string): string[] {
  return remediationCommand(owner, version);
}

export async function inspectSelfUpdateInstallation(
  version: string,
  options: InspectOptions = {}
): Promise<InstallationInspection> {
  const originalPath = options.path ?? options.env?.PATH ?? process.env.PATH ?? "";
  const platform = options.platform ?? process.platform;
  const env = { ...process.env, ...options.env, PATH: originalPath };
  const runner = options.runner ?? defaultRunner;
  const candidatePaths = enumerateExecutables("routekit", originalPath, platform);
  const candidates = (
    await Promise.all(candidatePaths.map((path) => inspectCandidate(path, env, runner)))
  ).filter((candidate): candidate is RouteKitCandidate => candidate !== undefined);
  const firstCandidate =
    candidatePaths[0] === undefined
      ? undefined
      : candidates.find(
          (candidate) =>
            normalize(resolve(candidate.path)) === normalize(resolve(candidatePaths[0]!))
        );
  const executingEntry = options.executingEntry ?? process.argv[1];
  const executingRoot =
    executingEntry === undefined ? undefined : packageRootFromEntry(shimTarget(executingEntry));
  const matching =
    executingRoot === undefined
      ? []
      : candidates.filter((candidate) => samePath(candidate.packageRoot, executingRoot));
  const diagnostics = [
    `PATH RouteKit executables: ${candidatePaths.length}`,
    ...candidatePaths.map((path, index) => `PATH executable ${index + 1}: ${path}`),
    `PATH RouteKit candidates: ${candidates.length}`,
    ...candidates.map(
      (candidate, index) =>
        `PATH candidate ${index + 1}: executable=${candidate.path} entry=${candidate.entry} package=${candidate.packageRoot} manifest=${candidate.manifestVersion} reported=${candidate.executableVersion}`
    ),
    `executing entry: ${executingEntry ?? "unresolved"}`,
    `executing package: ${executingRoot ?? "unresolved"}`
  ];
  const owners =
    executingRoot === undefined
      ? []
      : await detectOwners(executingRoot, originalPath, platform, env, runner);
  diagnostics.push(
    `matching package managers: ${owners.length}`,
    ...owners.map(
      (owner, index) =>
        `package manager ${index + 1}: kind=${owner.kind} executable=${owner.executable} package=${owner.packageRoot}${owner.prefix === undefined ? "" : ` prefix=${owner.prefix}`}${owner.globalBin === undefined ? "" : ` bin=${owner.globalBin}`}${owner.globalRoot === undefined ? "" : ` root=${owner.globalRoot}`}`
    )
  );
  const ownerHint = owners.length === 1 ? owners[0] : undefined;
  if (matching.length === 0) {
    throw new SelfUpdateInspectionError(
      "the executing RouteKit CLI does not match a RouteKit executable on the original PATH",
      remediationCommand(ownerHint, version),
      diagnostics
    );
  }
  if (firstCandidate === undefined) {
    throw new SelfUpdateInspectionError(
      "the first RouteKit executable on PATH could not be inspected",
      remediationCommand(ownerHint, version),
      diagnostics
    );
  }
  if (executingRoot === undefined || !samePath(firstCandidate.packageRoot, executingRoot)) {
    throw new SelfUpdateInspectionError(
      "the first RouteKit executable on PATH does not resolve to the executing package",
      remediationCommand(ownerHint, version),
      diagnostics
    );
  }
  const executing = firstCandidate;
  if (executing.manifestVersion !== executing.executableVersion) {
    throw new SelfUpdateInspectionError(
      "the executing RouteKit package manifest and executable versions do not match",
      remediationCommand(ownerHint, version),
      diagnostics
    );
  }
  if (owners.length !== 1) {
    const hint = owners.length > 0 ? owners[0] : undefined;
    throw new SelfUpdateInspectionError(
      owners.length === 0
        ? "could not identify the package manager that owns the executing RouteKit CLI"
        : "multiple package managers claim the executing RouteKit CLI",
      remediationCommand(hint, version),
      diagnostics
    );
  }
  const owner = owners[0]!;
  return {
    originalPath,
    executing,
    pathCandidates: candidates,
    owner,
    command: installCommand(owner, version),
    diagnostics
  };
}

export async function performSelfUpdate(
  version: string,
  dryRun: boolean,
  options: SelfUpdateOptions = {}
): Promise<SelfUpdateResult> {
  const targetVersion = await (options.resolveVersion ?? resolveInstallVersion)(version);
  const inspection = await inspectSelfUpdateInstallation(targetVersion, options);
  if (inspection.executing.executableVersion === targetVersion) {
    return {
      action: "skipped",
      from: inspection.executing.executableVersion,
      to: inspection.executing.executableVersion,
      version,
      targetVersion,
      owner: inspection.owner,
      command: inspection.command,
      diagnostics: inspection.diagnostics
    };
  }
  if (dryRun) {
    return {
      action: "planned",
      from: inspection.executing.executableVersion,
      to: inspection.executing.executableVersion,
      version,
      targetVersion,
      owner: inspection.owner,
      command: inspection.command,
      diagnostics: inspection.diagnostics
    };
  }
  const env = {
    ...process.env,
    ...options.env,
    PATH: inspection.originalPath
  };
  const runner = options.runner ?? defaultRunner;
  const result = await runner(inspection.command[0]!, inspection.command.slice(1), env);
  if (result.exitCode !== 0) {
    throw new SelfUpdateInspectionError(
      `the ${inspection.owner.kind} update command failed with exit ${result.exitCode}`,
      remediationCommand(inspection.owner, targetVersion),
      inspection.diagnostics
    );
  }
  const platform = options.platform ?? process.platform;
  const firstPath = enumerateExecutables(
    "routekit",
    inspection.originalPath,
    platform
  )[0];
  const fresh =
    firstPath === undefined ? undefined : await inspectCandidate(firstPath, env, runner);
  const freshOwners =
    fresh === undefined
      ? []
      : await detectOwners(fresh.packageRoot, inspection.originalPath, platform, env, runner);
  const ownedFresh =
    freshOwners.length === 1 && sameOwnerContext(freshOwners[0]!, inspection.owner);
  if (
    fresh === undefined ||
    !ownedFresh ||
    fresh.manifestVersion !== targetVersion ||
    fresh.executableVersion !== targetVersion
  ) {
    throw new SelfUpdateInspectionError(
      "RouteKit update verification failed: the owned package, manifest, and first PATH executable do not agree",
      remediationCommand(inspection.owner, targetVersion),
      [
        ...inspection.diagnostics,
        `fresh package: ${fresh?.packageRoot ?? "unresolved"}`,
        `fresh matching package managers: ${freshOwners.length}`,
        ...freshOwners.map(
          (owner, index) =>
            `fresh package manager ${index + 1}: kind=${owner.kind} executable=${owner.executable} package=${owner.packageRoot}${owner.prefix === undefined ? "" : ` prefix=${owner.prefix}`}${owner.globalBin === undefined ? "" : ` bin=${owner.globalBin}`}${owner.globalRoot === undefined ? "" : ` root=${owner.globalRoot}`}`
        ),
        `fresh manifest version: ${fresh?.manifestVersion ?? "unresolved"}`,
        `first PATH executable version: ${fresh?.executableVersion ?? "unresolved"}`
      ]
    );
  }
  return {
    action: "updated",
    from: inspection.executing.executableVersion,
    to: fresh.executableVersion,
    version,
    targetVersion,
    owner: inspection.owner,
    command: inspection.command,
    diagnostics: inspection.diagnostics
  };
}
