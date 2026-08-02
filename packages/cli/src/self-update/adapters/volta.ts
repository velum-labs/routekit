import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { inspectCandidate, samePath } from "../candidate.js";
import type { SelfUpdateAdapter, VoltaOwner } from "../types.js";
import {
  contextId,
  managerExecutables,
  outputLine,
  verifyDetectedOwner
} from "./shared.js";

function voltaHome(executable: string, env: NodeJS.ProcessEnv): string {
  return env.VOLTA_HOME ?? dirname(dirname(executable));
}

function voltaInventoryContainsRouteKit(home: string): boolean {
  const path = join(home, "tools", "user", "packages.json");
  if (!existsSync(path)) return false;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      packages?: Record<string, unknown>;
    };
    return Object.hasOwn(value.packages ?? {}, "@velum-labs/routekit");
  } catch {
    return false;
  }
}

export const voltaAdapter: SelfUpdateAdapter<VoltaOwner> = {
  kind: "volta",
  async detect(context) {
    const owners: VoltaOwner[] = [];
    for (const executable of managerExecutables("volta", context)) {
      const routekit = await outputLine(context, executable, ["which", "routekit"]);
      if (routekit === undefined) continue;
      const candidate = await inspectCandidate(routekit, context.env, context.runner);
      if (candidate === undefined || !samePath(candidate.packageRoot, context.packageRoot)) continue;
      const home = voltaHome(executable, context.env);
      if (!voltaInventoryContainsRouteKit(home)) continue;
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
