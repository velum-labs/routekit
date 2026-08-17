import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { inspectCandidate, packageManifest, samePath } from "../candidate.js";
import type { SelfUpdateAdapter, VoltaOwner } from "../types.js";
import { contextId, managerExecutables, outputLine, verifyDetectedOwner } from "./shared.js";

function voltaHome(executable: string, env: NodeJS.ProcessEnv): string {
  return env.VOLTA_HOME ?? dirname(dirname(executable));
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function voltaInventoryContainsRouteKit(home: string, packageRoot: string): boolean {
  const manifest = packageManifest(packageRoot);
  if (typeof manifest?.version !== "string") return false;

  const packageRecord = readJson(
    join(home, "tools", "user", "packages", "@velum-labs", "routekit.json")
  ) as
    | {
        name?: unknown;
        version?: unknown;
        bins?: unknown;
      }
    | undefined;
  const binRecord = readJson(join(home, "tools", "user", "bins", "routekit.json")) as
    | {
        name?: unknown;
        package?: unknown;
        version?: unknown;
      }
    | undefined;
  return (
    packageRecord?.name === "@velum-labs/routekit" &&
    packageRecord.version === manifest.version &&
    Array.isArray(packageRecord.bins) &&
    packageRecord.bins.includes("routekit") &&
    binRecord?.name === "routekit" &&
    binRecord.package === "@velum-labs/routekit" &&
    binRecord.version === manifest.version
  );
}

function matchesVoltaPackageLayout(
  home: string,
  routekitExecutable: string,
  packageRoot: string
): boolean {
  const image = join(home, "tools", "image", "packages", "@velum-labs", "routekit");
  return (
    samePath(routekitExecutable, join(image, "bin", "routekit")) &&
    samePath(packageRoot, join(image, "lib", "node_modules", "@velum-labs", "routekit"))
  );
}

async function routekitBelongsToPackage(
  routekit: string,
  home: string,
  context: Parameters<SelfUpdateAdapter<VoltaOwner>["detect"]>[0]
): Promise<boolean> {
  const candidate = await inspectCandidate(routekit, context.env, context.runner);
  return (
    candidate !== undefined &&
    samePath(candidate.packageRoot, context.packageRoot) &&
    matchesVoltaPackageLayout(home, routekit, context.packageRoot)
  );
}

export const voltaAdapter: SelfUpdateAdapter<VoltaOwner> = {
  kind: "volta",
  async detect(context) {
    const owners: VoltaOwner[] = [];
    for (const executable of managerExecutables("volta", context)) {
      const routekit = await outputLine(context, executable, ["which", "routekit"]);
      if (routekit === undefined) continue;
      const home = voltaHome(executable, context.env);
      if (!(await routekitBelongsToPackage(routekit, home, context))) continue;
      if (!voltaInventoryContainsRouteKit(home, context.packageRoot)) continue;
      const owner: VoltaOwner = {
        kind: "volta",
        provenance: "package-manager",
        executable,
        packageRoot: context.packageRoot,
        binDirectory: join(home, "bin"),
        voltaHome: home,
        contextId: contextId("volta", home)
      };
      if (!owners.some((candidate) => candidate.contextId === owner.contextId)) owners.push(owner);
    }
    return owners;
  },
  buildUpdate(owner, targetVersion, context) {
    return {
      executable: owner.executable,
      args: ["install", `@velum-labs/routekit@${targetVersion}`],
      env: context.env,
      cwd: context.neutralCwd,
      operation: "install"
    };
  },
  async verifyOwner(owner, _fresh, context) {
    return await verifyDetectedOwner(owner, context, voltaAdapter.detect);
  }
};
