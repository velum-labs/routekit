import { join } from "node:path";

import { samePath } from "../candidate.js";
import type { SelfUpdateAdapter, YarnOwner } from "../types.js";
import {
  contextId,
  managerExecutables,
  outputLine,
  verifyDetectedOwner,
  versionMajor
} from "./shared.js";

export const yarnAdapter: SelfUpdateAdapter<YarnOwner> = {
  kind: "yarn",
  async detect(context) {
    const owners: YarnOwner[] = [];
    for (const executable of managerExecutables("yarn", context)) {
      const version = await outputLine(context, executable, ["--version"]);
      if (version === undefined || versionMajor(version) !== 1) continue;
      const globalRoot = await outputLine(context, executable, ["global", "dir"]);
      const globalBin = await outputLine(context, executable, ["global", "bin"]);
      if (globalRoot === undefined || globalBin === undefined) continue;
      const location = join(globalRoot, "node_modules", "@velum-labs", "routekit");
      if (!samePath(location, context.packageRoot)) continue;
      const owner: YarnOwner = {
        kind: "yarn",
        provenance: "package-manager",
        executable,
        packageRoot: context.packageRoot,
        binDirectory: globalBin,
        globalBin,
        globalRoot,
        contextId: contextId("yarn", globalRoot, globalBin)
      };
      if (!owners.some((candidate) => candidate.contextId === owner.contextId)) owners.push(owner);
    }
    return owners;
  },
  buildUpdate(owner, targetVersion, context) {
    return {
      executable: owner.executable,
      args: [
        "global",
        "add",
        `@velum-labs/routekit@${targetVersion}`,
        "--force",
        "--non-interactive"
      ],
      env: context.env,
      cwd: context.neutralCwd,
      operation: "install"
    };
  },
  async verifyOwner(owner, _fresh, context) {
    return await verifyDetectedOwner(owner, context, yarnAdapter.detect);
  }
};
