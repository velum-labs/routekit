import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CreateEvalAuthorTurnInput,
  CreateEvalAuthorTurnResult,
  ProductionAuthorTurnAdapter,
  ProductionAuthorTurnAdapterOptions,
  ProductionHeadlessAuthorInput,
} from "./public-api.ts";
import {
  applyHostProviderEnv,
  withHostProviderEnvironment,
  withProcessEnvOverlay,
} from "./host-env.ts";
import { ensureIsolatedOriChildAuth } from "./isolated-ori-child-auth.ts";

type ProductionHeadlessAuthor = (
  input: ProductionHeadlessAuthorInput,
) => Promise<CreateEvalAuthorTurnResult>;

const dedicatedEvalToolCommand = (): readonly [string, ...string[]] => {
  const sourceLaunch = import.meta.url.endsWith(".ts");
  const worker = fileURLToPath(
    new URL(sourceLaunch ? "./eval-tool-entry.ts" : "./eval-tool.mjs", import.meta.url),
  );
  return sourceLaunch
    ? [process.execPath, "--experimental-strip-types", "--experimental-sqlite", worker]
    : [process.execPath, worker];
};

const runProductionHeadlessAuthor = async (
  input: ProductionHeadlessAuthorInput,
  seam?: ProductionHeadlessAuthor,
): Promise<CreateEvalAuthorTurnResult> => {
  const environment = {
    ...input.environment,
    HOME: input.homeDirectory,
    ORI_EVAL_TOOL_HOME: input.homeDirectory,
    ORI_PERSONA: "code",
  };
  applyHostProviderEnv(environment);
  return withHostProviderEnvironment(environment, () =>
    withProcessEnvOverlay(environment, async () => {
      await ensureIsolatedOriChildAuth(environment, input.cwd);
      if (seam !== undefined) {
        return seam({ ...input, environment });
      }
      return (await import("./production-headless-runtime.ts")).runProductionHeadlessRuntime({
        ...input,
        environment,
      });
    }),
  );
};

const createProductionAuthorTurnAdapter = (
  options: ProductionAuthorTurnAdapterOptions = {},
): ProductionAuthorTurnAdapter => {
  return {
    evalCommand: options.evalToolCommand ?? dedicatedEvalToolCommand(),
    runAuthorTurn: (input) =>
      runProductionHeadlessAuthor(
        {
          ...input,
          homeDirectory: path.join(input.runDirectory, "ori-home"),
        },
        options.runHeadlessAuthor,
      ),
  };
};

export {
  createProductionAuthorTurnAdapter,
  runProductionHeadlessAuthor,
};
export type {
  ProductionHeadlessAuthor,
};
