import { readFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { readBuildTimeVersionInfo } from "./vendor/framework/cli/src/build-info.ts";
import { reportCommandFailure } from "./vendor/framework/cli/src/command-failure.ts";
import { CliIo } from "./vendor/framework/contracts/internal/src/cli/cli-io.ts";
import { renderEnvelope } from "./vendor/framework/contracts/internal/src/cli/cli-output.ts";
import { currentOutputMode } from "./vendor/framework/contracts/internal/src/cli/output-mode.ts";

const VERSION_COMMAND_LABEL = "version";
const PACKAGE_JSON = path.resolve(import.meta.dirname, "../package.json");

const readPackageVersion = Effect.fn("EvalSystem.readPackageVersion")(
  function* () {
    const raw = yield* Effect.tryPromise(() => readFile(PACKAGE_JSON, "utf8"));
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return {
      name: parsed.name?.trim() || "@ori/eval-system",
      version: parsed.version?.trim() || "0.0.0",
    };
  },
);

export const evalSystemVersionCommand = Command.make("version", {}, () =>
  Effect.gen(function* () {
    const cliIo = yield* CliIo;
    const info = readBuildTimeVersionInfo() ?? (yield* readPackageVersion());
    if ((yield* currentOutputMode()) === "json") {
      yield* cliIo.writeStdout(renderEnvelope(VERSION_COMMAND_LABEL, info));
      return;
    }
    yield* cliIo.writeStdout(`${info.name} ${info.version}\n`);
  }).pipe(reportCommandFailure(VERSION_COMMAND_LABEL)),
).pipe(
  Command.withDescription(
    "Print the eval-system package name and version. Takes no arguments.",
  ),
);
