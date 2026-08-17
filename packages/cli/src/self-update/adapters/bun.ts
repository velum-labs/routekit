import { dirname, join } from "node:path";

import { packageManifest, samePath } from "../candidate.js";
import type { BunOwner, SelfUpdateAdapter } from "../types.js";
import { contextId, managerExecutables, outputLine, verifyDetectedOwner } from "./shared.js";

function bunGlobalRoot(globalBin: string, env: NodeJS.ProcessEnv): string {
  const bunHome = env.BUN_INSTALL ?? dirname(globalBin);
  return join(bunHome, "install", "global");
}

export const bunAdapter: SelfUpdateAdapter<BunOwner> = {
  kind: "bun",
  async detect(context) {
    const owners: BunOwner[] = [];
    for (const executable of managerExecutables("bun", context)) {
      const globalBin = await outputLine(context, executable, ["pm", "bin", "-g"]);
      if (globalBin === undefined) continue;
      const globalRoot = bunGlobalRoot(globalBin, context.env);
      const project = packageManifest(globalRoot);
      const dependency =
        typeof project?.dependencies === "object" && project.dependencies !== null
          ? Reflect.get(project.dependencies, "@velum-labs/routekit")
          : undefined;
      const location = join(globalRoot, "node_modules", "@velum-labs", "routekit");
      if (typeof dependency !== "string" || !samePath(location, context.packageRoot)) continue;
      const owner: BunOwner = {
        kind: "bun",
        provenance: "package-manager",
        executable,
        packageRoot: context.packageRoot,
        binDirectory: globalBin,
        globalBin,
        globalRoot,
        contextId: contextId("bun", globalRoot, globalBin)
      };
      if (!owners.some((candidate) => candidate.contextId === owner.contextId)) owners.push(owner);
    }
    return owners;
  },
  buildUpdate(owner, targetVersion, context) {
    return {
      executable: owner.executable,
      args: ["add", "-g", "--exact", "--force", `@velum-labs/routekit@${targetVersion}`],
      env: context.env,
      cwd: context.neutralCwd,
      operation: "install"
    };
  },
  async verifyOwner(owner, _fresh, context) {
    return await verifyDetectedOwner(owner, context, bunAdapter.detect);
  }
};
