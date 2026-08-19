import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CliRuntime,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { packageRootFromEntry } from "../../self-update/candidate.js";
import { ROUTEKIT_PACKAGE_NAME } from "../../self-update/types.js";

export const makeSelfInspectCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any =>
  Command.make("__self-inspect", {}, () =>
    Effect.sync(() => {
      const moduleEntry = fileURLToPath(import.meta.url);
      const packageRoot = packageRootFromEntry(moduleEntry);
      if (packageRoot === undefined) throw new Error("RouteKit package root is unresolved");
      const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof manifest.version !== "string") {
        throw new Error("RouteKit package version is unresolved");
      }
      runtime.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          packageName: ROUTEKIT_PACKAGE_NAME,
          packageRoot,
          entry: join(packageRoot, "dist", "index.js"),
          version: manifest.version,
          processExecPath: process.execPath
        })}\n`
      );
    })
  ).pipe(
    Command.withDescription("internal installation inspection protocol"),
    Command.unlisted
  );
