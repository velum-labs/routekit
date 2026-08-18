import { mkdir } from "node:fs/promises";

import { Effect, Layer, Option, Result } from "effect";
import { makeProvidedEvalCliLayer } from "./product-catalog.ts";
import { makeProductDaemonRuntime } from "./product-daemon-runtime.ts";
import type { CreateEvalAuthorTurnResult, ProductionHeadlessAuthorInput } from "./public-api.ts";
import { makeIsolatedRuntimeIo } from "./runtime/isolated-runtime.ts";
import { runCodeHeadlessSession } from "./vendor/framework/cli/src/commands/code/session-boot.ts";
import { codeHeadlessConfig } from "./vendor/framework/cli/src/commands/code/session-config.ts";
import { DEFAULT_DAEMON_HOST } from "./vendor/framework/cli/src/commands/dev/session-support.ts";
import { ensureGlobalWorkspaceForCode } from "./vendor/framework/cli/src/commands/init/global-workspace.ts";
import { DaemonShutdown } from "./vendor/framework/cli/src/daemon-shutdown.ts";
import { OriDirectoryLive } from "./vendor/framework/cli/src/ori-directory-live.ts";
import { ORI_PERSONA_ENV } from "./vendor/framework/contracts/internal/src/cli/intern-launcher-env.ts";
import { fetchHttpClientLayer } from "./vendor/framework/contracts/internal/src/http-client.ts";
import { nodeServicesLayer } from "./vendor/framework/runloop/local/src/runtime/io-layer.ts";

const runProductionHeadlessRuntime = async (
  input: ProductionHeadlessAuthorInput,
  runHeadlessAuthor?: (input: ProductionHeadlessAuthorInput) => Promise<CreateEvalAuthorTurnResult>
): Promise<CreateEvalAuthorTurnResult> => {
  const environment: NodeJS.ProcessEnv = {
    ...input.environment,
    HOME: input.homeDirectory,
    ORI_EVAL_TOOL_HOME: input.homeDirectory,
    [ORI_PERSONA_ENV]: "code"
  };
  await mkdir(input.homeDirectory, { recursive: true, mode: 0o700 });
  if (runHeadlessAuthor !== undefined) {
    return runHeadlessAuthor({
      ...input,
      environment
    });
  }
  const { runtimeIo, stderr, stdout } = makeIsolatedRuntimeIo({
    cwd: input.cwd,
    environment,
    homeDirectory: input.homeDirectory
  });
  const provided = Layer.mergeAll(
    DaemonShutdown.layer,
    makeProvidedEvalCliLayer(runtimeIo),
    fetchHttpClientLayer,
    nodeServicesLayer,
    OriDirectoryLive
  );
  const program = Effect.scoped(
    Effect.gen(function* () {
      const featuresRoot = yield* ensureGlobalWorkspaceForCode(false);
      const authSource = Option.some({
        kind: "environment" as const,
        location: "OPENROUTER_API_KEY"
      });
      const session = codeHeadlessConfig({
        authSource,
        featuresRoot,
        harness: input.harness,
        host: DEFAULT_DAEMON_HOST,
        launchCwd: input.cwd,
        model: input.model,
        port: Option.none()
      });
      yield* runCodeHeadlessSession({
        harness: input.harness,
        launchCwd: input.cwd,
        model: input.model,
        options: {
          makeDaemonRuntime: (options) =>
            makeProductDaemonRuntime({
              ...options,
              runtimeIo
            })
        },
        output: "prose",
        prompt: input.prompt,
        session
      });
    })
  ).pipe(Effect.provide(provided), Effect.provide(nodeServicesLayer), Effect.result);
  const result = await Effect.runPromise(program);
  if (Result.isFailure(result)) {
    const failure = result.failure;
    return {
      exitCode:
        typeof failure === "object" && failure !== null && "exitCode" in failure
          ? Number(failure.exitCode)
          : 1,
      stderr: `${stderr.join("")}${failure instanceof Error ? failure.message : String(failure)}`,
      stdout: stdout.join("")
    };
  }
  return {
    exitCode: 0,
    stderr: stderr.join(""),
    stdout: stdout.join("")
  };
};

export { runProductionHeadlessRuntime };
