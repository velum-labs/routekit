import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { packageRootFromEntry } from "../self-update/candidate.js";
import { ROUTEKIT_PACKAGE_NAME } from "../self-update/types.js";

export function registerSelfInspect(program: Command): void {
  const command = new Command("__self-inspect")
    .description("internal installation inspection protocol")
    .helpOption(false)
    .action(() => {
      const moduleEntry = fileURLToPath(import.meta.url);
      const packageRoot = packageRootFromEntry(moduleEntry);
      if (packageRoot === undefined) throw new Error("RouteKit package root is unresolved");
      const manifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8")
      ) as { version?: unknown };
      if (typeof manifest.version !== "string")
        throw new Error("RouteKit package version is unresolved");
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          packageName: ROUTEKIT_PACKAGE_NAME,
          packageRoot,
          entry: join(packageRoot, "dist", "index.js"),
          version: manifest.version,
          processExecPath: process.execPath
        })}\n`
      );
    });
  program.addCommand(command, { hidden: true });
}
