import { dirname, join } from "node:path";

import { samePath } from "../candidate.js";
import type { DiscoveryContext, PnpmOwner, SelfUpdateAdapter } from "../types.js";
import { contextId, managerExecutables, outputLine, verifyDetectedOwner } from "./shared.js";

function parseLocations(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export const pnpmAdapter: SelfUpdateAdapter<PnpmOwner> = {
  kind: "pnpm",
  async detect(context) {
    const owners: PnpmOwner[] = [];
    for (const executable of managerExecutables("pnpm", context)) {
      const globalBin = await outputLine(context, executable, ["bin", "-g"]);
      const globalRoot = await outputLine(context, executable, ["root", "-g"]);
      if (globalRoot === undefined) continue;
      const listed = await context.runner(
        executable,
        ["list", "-g", "--depth", "0", "--parseable"],
        context.env,
        { cwd: context.neutralCwd, operation: "probe" }
      );
      if (listed.exitCode !== 0) continue;
      const locations = parseLocations(listed.stdout);
      if (!locations.some((location) => samePath(location, context.packageRoot))) continue;
      const binDirectory = globalBin ?? dirname(executable);
      const owner: PnpmOwner = {
        kind: "pnpm",
        provenance: "package-manager",
        executable,
        packageRoot: context.packageRoot,
        binDirectory,
        globalBin: binDirectory,
        globalRoot,
        contextId: contextId("pnpm", globalRoot, binDirectory)
      };
      if (!owners.some((candidate) => candidate.contextId === owner.contextId)) owners.push(owner);
    }
    return owners;
  },
  buildUpdate(owner, targetVersion, context) {
    return {
      executable: owner.executable,
      args: [
        "add",
        "-g",
        `@velum-labs/routekit@${targetVersion}`,
        "--config.minimum-release-age=0"
      ],
      env: context.env,
      cwd: context.neutralCwd,
      operation: "install"
    };
  },
  async verifyOwner(owner, _fresh, context) {
    return await verifyDetectedOwner(owner, context, pnpmAdapter.detect);
  }
};
