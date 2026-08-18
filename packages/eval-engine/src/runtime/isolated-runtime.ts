import { access } from "node:fs/promises";
import path from "node:path";

import { Effect, Option } from "effect";

import { CliIo } from "../vendor/framework/contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../vendor/framework/contracts/internal/src/cli/host-process.ts";
import { makeRuntimeIoLayers } from "../vendor/framework/runloop/local/src/runtime/io-layer.ts";

const executableFromEnvironment = async (
  command: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> => {
  const candidates = path.isAbsolute(command)
    ? [command]
    : (environment.PATH ?? "")
        .split(path.delimiter)
        .filter((entry) => entry !== "")
        .map((entry) => path.join(entry, command));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return undefined;
};

const makeIsolatedRuntimeIo = (input: {
  readonly cwd: string;
  readonly environment: Record<string, string | undefined>;
  readonly homeDirectory: string;
}) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const hostProcess = HostProcess.layerTest({
    currentExecutablePath: Effect.succeed(Option.some(process.execPath)),
    currentWorkingDirectory: Effect.succeed(input.cwd),
    env: Effect.succeed(input.environment),
    homeDirectory: Effect.succeed(input.homeDirectory),
    resolveExecutablePath: (command) =>
      Effect.promise(async () =>
        Option.fromUndefinedOr(
          await executableFromEnvironment(command, input.environment),
        ),
      ),
    setEnv: (name, value) =>
      Effect.sync(() => {
        if (value === undefined) {
          delete input.environment[name];
        } else {
          input.environment[name] = value;
        }
      }),
  });
  const cliIo = CliIo.layerTest({
    writeStdout: (text) =>
      Effect.sync(() => {
        stdout.push(text);
      }),
    writeStderr: (text) =>
      Effect.sync(() => {
        stderr.push(text);
      }),
  });
  return {
    environment: input.environment,
    runtimeIo: makeRuntimeIoLayers({ cliIo, hostProcess }),
    stderr,
    stdout,
  };
};

export { makeIsolatedRuntimeIo };
