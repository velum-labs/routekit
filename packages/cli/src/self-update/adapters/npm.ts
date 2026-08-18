import { dirname, join } from "node:path";

import { samePath } from "../candidate.js";
import { isPrivateInstallerNpm, readInstallerReceipt } from "../receipt.js";
import type { DiscoveryContext, NpmOwner, SelfUpdateAdapter } from "../types.js";
import { contextId, managerExecutables, outputLine, verifyDetectedOwner } from "./shared.js";

function npmPackageLocations(root: string, prefix: string): string[] {
  return [
    join(root, "@velum-labs", "routekit"),
    join(prefix, "lib", "node_modules", "@velum-labs", "routekit"),
    join(prefix, "node_modules", "@velum-labs", "routekit")
  ];
}

function inventoryOwnsPackage(
  output: string,
  packageRoot: string,
  locations: readonly string[]
): boolean {
  try {
    const parsed = JSON.parse(output) as {
      path?: unknown;
      dependencies?: Record<
        string,
        {
          path?: unknown;
          resolved?: unknown;
          link?: unknown;
          extraneous?: unknown;
        }
      >;
    };
    const dependency = parsed.dependencies?.["@velum-labs/routekit"];
    if (dependency === undefined || dependency.link === true) return false;
    if (
      typeof dependency.resolved === "string" &&
      (dependency.resolved.startsWith("file:") || dependency.resolved.startsWith("link:"))
    )
      return false;
    const inventoryPath = typeof dependency.path === "string" ? dependency.path : undefined;
    const inventoryRoot = typeof parsed.path === "string" ? parsed.path : undefined;
    const inventoryPrefixMatches =
      inventoryRoot !== undefined &&
      locations.some(
        (location) =>
          samePath(location, packageRoot) && canonicalLocationStartsWith(location, inventoryRoot)
      );
    return (
      (inventoryPath !== undefined && samePath(inventoryPath, packageRoot)) ||
      inventoryPrefixMatches
    );
  } catch {
    return false;
  }
}

function canonicalLocationStartsWith(location: string, root: string): boolean {
  const normalizedLocation = location.replaceAll("\\", "/");
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
  return (
    normalizedLocation === normalizedRoot || normalizedLocation.startsWith(`${normalizedRoot}/`)
  );
}

export const npmAdapter: SelfUpdateAdapter<NpmOwner> = {
  kind: "npm",
  async detect(context) {
    const owners: NpmOwner[] = [];
    const receipt = readInstallerReceipt(context.packageRoot);
    for (const executable of managerExecutables("npm", context)) {
      const prefix = await outputLine(context, executable, ["prefix", "-g"]);
      const globalRoot = await outputLine(context, executable, ["root", "-g"]);
      if (prefix === undefined || globalRoot === undefined) continue;
      const locations = npmPackageLocations(globalRoot, prefix);
      if (!locations.some((location) => samePath(location, context.packageRoot))) continue;
      const inventory = await context.runner(
        executable,
        ["ls", "-g", "--depth", "0", "--json", "--long", "@velum-labs/routekit"],
        context.env,
        { cwd: context.neutralCwd, operation: "probe" }
      );
      const receiptMatches =
        receipt !== undefined &&
        samePath(receipt.receipt.prefix, prefix) &&
        samePath(receipt.receipt.npmExecutable, executable);
      const privateInstallerMatches = isPrivateInstallerNpm(executable, prefix, context.env);
      if (
        !receiptMatches &&
        !privateInstallerMatches &&
        !inventoryOwnsPackage(inventory.stdout, context.packageRoot, locations)
      )
        continue;
      const owner: NpmOwner = {
        kind: "npm",
        provenance:
          receiptMatches || privateInstallerMatches ? "routekit-installer" : "package-manager",
        executable,
        packageRoot: context.packageRoot,
        binDirectory: process.platform === "win32" ? prefix : join(prefix, "bin"),
        prefix,
        globalRoot,
        contextId: contextId("npm", prefix),
        ...(receipt !== undefined ? { receiptPath: receipt.path } : {})
      };
      if (!owners.some((candidate) => candidate.contextId === owner.contextId)) owners.push(owner);
    }
    return owners;
  },
  buildUpdate(owner, targetVersion, context) {
    return {
      executable: owner.executable,
      args: [
        "install",
        "-g",
        "--force",
        "--no-audit",
        "--no-fund",
        "--prefix",
        owner.prefix,
        `@velum-labs/routekit@${targetVersion}`
      ],
      env: context.env,
      cwd: context.neutralCwd,
      operation: "install"
    };
  },
  async verifyOwner(owner, _fresh, context) {
    return await verifyDetectedOwner(owner, context, npmAdapter.detect);
  }
};
