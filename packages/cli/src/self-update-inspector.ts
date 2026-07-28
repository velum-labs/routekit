import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@velum-labs/routekit";
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

export type SelfUpdateResult = {
  action: "planned" | "updated";
  from: string;
  to: string;
  version: string;
  owner: PackageOwner;
  command: readonly string[];
  diagnostics: readonly string[];
};

export class SelfUpdateInspectionError extends Error {
  readonly remediation: string;
  readonly diagnostics: readonly string[];

  constructor(message: string, remediation: string, diagnostics: readonly string[]) {
    super(`${message}\nRemediation: ${remediation}`);
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
    if (manifest?.name === PACKAGE_NAME && typeof manifest.version === "string") return current;
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
      owners.push({ kind: "npm", executable, packageRoot, prefix });
    }
  }
  for (const executable of enumerateExecutables("pnpm", pathValue, platform)) {
    const globalBin = await managerOutput(executable, ["bin", "-g"], env, runner);
    const globalRoot = await managerOutput(executable, ["root", "-g"], env, runner);
    if (globalRoot === undefined) continue;
    if (packageLocations(globalRoot).some((location) => samePath(location, packageRoot))) {
      owners.push({ kind: "pnpm", executable, packageRoot, globalBin, globalRoot });
    }
  }
  return owners;
}

/**
 * Windows argument quoting follows CommandLineToArgvW: a backslash run is
 * literal unless it precedes a quote, where it must be doubled. Escaping the
 * quotes alone would let a trailing backslash terminate the quoted argument.
 */
function windowsQuote(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return windowsQuote(value);
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function remediationCommand(
  owner: PackageOwner | undefined,
  version: string,
  platform: NodeJS.Platform = process.platform
): string {
  const specifier = `${PACKAGE_NAME}@${version}`;
  const argv =
    owner?.kind === "npm"
      ? [owner.executable, "install", "-g", "--force", "--prefix", owner.prefix!, specifier]
      : owner?.kind === "pnpm"
        ? [owner.executable, "add", "-g", specifier]
        : ["npm", "install", "-g", "--force", specifier];
  return argv.map((part) => shellQuote(part, platform)).join(" ");
}

function installCommand(owner: PackageOwner, version: string): string[] {
  const specifier = `${PACKAGE_NAME}@${version}`;
  return owner.kind === "npm"
    ? [owner.executable, "install", "-g", "--force", "--prefix", owner.prefix!, specifier]
    : [owner.executable, "add", "-g", specifier];
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
  const executingEntry = options.executingEntry ?? process.argv[1];
  const executingRoot =
    executingEntry === undefined ? undefined : packageRootFromEntry(shimTarget(executingEntry));
  const matching =
    executingRoot === undefined
      ? []
      : candidates.filter((candidate) => samePath(candidate.packageRoot, executingRoot));
  const ownedRoots = new Set(candidates.map((candidate) => normalize(candidate.packageRoot)));
  const firstMatches =
    executingRoot !== undefined &&
    candidates[0] !== undefined &&
    samePath(candidates[0].packageRoot, executingRoot);
  const diagnostics = [
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
  if (matching.length === 0 || !firstMatches || ownedRoots.size !== 1) {
    throw new SelfUpdateInspectionError(
      matching.length === 0
        ? "the executing RouteKit CLI does not match a RouteKit executable on the original PATH"
        : "the first RouteKit executable on PATH does not uniquely resolve to the executing package",
      remediationCommand(ownerHint, version, platform),
      diagnostics
    );
  }
  const executing = matching[0]!;
  if (executing.manifestVersion !== executing.executableVersion) {
    throw new SelfUpdateInspectionError(
      "the executing RouteKit package manifest and executable versions do not match",
      remediationCommand(ownerHint, version, platform),
      diagnostics
    );
  }
  if (owners.length !== 1) {
    const hint = owners.length > 0 ? owners[0] : undefined;
    throw new SelfUpdateInspectionError(
      owners.length === 0
        ? "could not identify the package manager that owns the executing RouteKit CLI"
        : "multiple package managers claim the executing RouteKit CLI",
      remediationCommand(hint, version, platform),
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
  options: InspectOptions = {}
): Promise<SelfUpdateResult> {
  const inspection = await inspectSelfUpdateInstallation(version, options);
  if (dryRun) {
    return {
      action: "planned",
      from: inspection.executing.executableVersion,
      to: inspection.executing.executableVersion,
      version,
      owner: inspection.owner,
      command: inspection.command,
      diagnostics: inspection.diagnostics
    };
  }
  const env = {
    ...process.env,
    ...options.env,
    PATH: inspection.originalPath,
    ...(inspection.owner.kind === "pnpm" && inspection.owner.globalBin !== undefined
      ? { PNPM_HOME: inspection.owner.globalBin }
      : {})
  };
  const runner = options.runner ?? defaultRunner;
  const result = await runner(inspection.command[0]!, inspection.command.slice(1), env);
  if (result.exitCode !== 0) {
    throw new SelfUpdateInspectionError(
      `the ${inspection.owner.kind} update command failed with exit ${result.exitCode}`,
      remediationCommand(inspection.owner, version, options.platform),
      inspection.diagnostics
    );
  }
  const manifest = packageManifest(inspection.owner.packageRoot);
  const manifestVersion = typeof manifest?.version === "string" ? manifest.version : undefined;
  const firstPath = enumerateExecutables(
    "routekit",
    inspection.originalPath,
    options.platform ?? process.platform
  )[0];
  const fresh =
    firstPath === undefined ? undefined : await inspectCandidate(firstPath, env, runner);
  const expected = version === "latest" ? manifestVersion : version;
  if (
    manifestVersion === undefined ||
    fresh === undefined ||
    !samePath(fresh.packageRoot, inspection.owner.packageRoot) ||
    fresh.manifestVersion !== manifestVersion ||
    fresh.executableVersion !== manifestVersion ||
    expected !== manifestVersion
  ) {
    throw new SelfUpdateInspectionError(
      "RouteKit update verification failed: the owned package, manifest, and first PATH executable do not agree",
      remediationCommand(inspection.owner, version, options.platform),
      [
        ...inspection.diagnostics,
        `owned manifest version: ${manifestVersion ?? "unresolved"}`,
        `first PATH executable version: ${fresh?.executableVersion ?? "unresolved"}`
      ]
    );
  }
  return {
    action: "updated",
    from: inspection.executing.executableVersion,
    to: fresh.executableVersion,
    version,
    owner: inspection.owner,
    command: inspection.command,
    diagnostics: inspection.diagnostics
  };
}
