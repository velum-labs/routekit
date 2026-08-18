import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { neutralSelfUpdateCwd } from "./runner.js";
import { type CommandRunner, ROUTEKIT_PACKAGE_NAME, type RouteKitCandidate } from "./types.js";

export function canonicalPath(value: string): string {
  try {
    return normalize(realpathSync(value));
  } catch {
    return normalize(resolve(value));
  }
}

export function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

export function packageManifest(
  root: string
): { name?: unknown; version?: unknown; dependencies?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
      dependencies?: unknown;
    };
  } catch {
    return undefined;
  }
}

export function packageRootFromEntry(entry: string): string | undefined {
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

export function shimTarget(path: string): string {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // Continue with text-shim parsing below.
  }
  if (packageRootFromEntry(real) !== undefined) return real;
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

function executableNames(name: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
}

export function findExecutablesInDirectory(
  name: string,
  directory: string,
  platform: NodeJS.Platform
): string[] {
  return executableNames(name, platform)
    .map((executable) => resolve(directory, executable))
    .filter((candidate) => {
      if (!existsSync(candidate)) return false;
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
}

export function enumerateExecutables(
  name: string,
  pathValue: string,
  platform: NodeJS.Platform
): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const candidate of findExecutablesInDirectory(name, directory, platform)) {
      const canonical = canonicalPath(candidate);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      found.push(candidate);
      break;
    }
  }
  return found;
}

type SelfInspectPayload = {
  schemaVersion?: unknown;
  packageName?: unknown;
  packageRoot?: unknown;
  entry?: unknown;
  version?: unknown;
  processExecPath?: unknown;
};

function parseSelfInspect(output: string): SelfInspectPayload | undefined {
  const candidates = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .reverse();
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as SelfInspectPayload;
    } catch {
      // Try an earlier line.
    }
  }
  return undefined;
}

export async function inspectCandidate(
  path: string,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner
): Promise<RouteKitCandidate | undefined> {
  const protocolResult = await runner(path, ["__self-inspect", "--json"], env, {
    cwd: neutralSelfUpdateCwd,
    operation: "probe"
  });
  if (protocolResult.exitCode === 0) {
    const payload = parseSelfInspect(protocolResult.stdout);
    if (
      payload?.schemaVersion === 1 &&
      payload.packageName === ROUTEKIT_PACKAGE_NAME &&
      typeof payload.packageRoot === "string" &&
      typeof payload.entry === "string" &&
      typeof payload.version === "string"
    ) {
      const manifest = packageManifest(payload.packageRoot);
      const entryRoot = packageRootFromEntry(payload.entry);
      if (
        manifest?.name === ROUTEKIT_PACKAGE_NAME &&
        manifest.version === payload.version &&
        entryRoot !== undefined &&
        samePath(entryRoot, payload.packageRoot)
      ) {
        return {
          path,
          entry: payload.entry,
          packageRoot: payload.packageRoot,
          manifestVersion: payload.version,
          executableVersion: payload.version,
          ...(typeof payload.processExecPath === "string"
            ? { processExecPath: payload.processExecPath }
            : {}),
          protocol: "self-inspect"
        };
      }
    }
  }

  return undefined;
}
