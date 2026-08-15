import type { AgentParameters } from "../../../routekit-eval/src/index.ts";

import { join } from "node:path";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Result } from "effect";
import { harnessEffortFlag } from "../../../routekit-eval/src/index.ts";

import type { PiHarnessConfig } from "../harness/harness.ts";

import { materializeAskUserExtension } from "../ask-user/ask-user-setup.ts";
import { materializeBashSummaryExtension } from "../bash-summary/bash-summary-setup.ts";
import { ensurePiCompactionSettings } from "../compaction/pi-compaction-settings.ts";
import { readPiHarnessConfig } from "../harness/harness.ts";
import { resolvePiInvocation } from "../harness/pi-runtime.ts";
import {
  removePiPromptFiles,
  writePiPromptFiles,
} from "../harness/prompt-files.ts";
import {
  clampMaxTokensToAfford,
  describeCreditShortfall,
  forceGatewayModelSlug,
  parseAffordableMaxTokens,
  piGatewayModelId,
  readPiDefaultModel,
  resolvePiMaxTokensCap,
} from "../model/model.ts";
import {
  ensurePiGatewayAttribution,
  PI_CODING_AGENT_DIR_ENV,
  resolvePiAgentDir,
} from "../gateway-attribution/gateway-attribution.ts";
import { materializeGatewaySessionAttributionExtension } from "../gateway-session-attribution/gateway-session-attribution-setup.ts";
import { ensurePiBinary } from "../pi-install/pi-install.ts";
import { setUpWebToolsExtension } from "../web-tools/web-tools-setup.ts";

interface PiAcpLaunch {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly dispose?: (() => Promise<void>) | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

interface PiAcpPrepareOptions {
  readonly contextWindow?: number | undefined;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly extraSkillDirs?: readonly string[] | undefined;
  readonly parameters?: AgentParameters | undefined;
  readonly model?: string | null | undefined;
  readonly systemPrompt?: string | undefined;
}

const resolvePiRuntimeModel = (
  requested: string | null | undefined,
  env: NodeJS.ProcessEnv
): string => {
  const trimmed = requested?.trim();
  return trimmed !== undefined && trimmed.length > 0
    ? trimmed
    : readPiDefaultModel(env);
};

const piThinkingLevel = (
  effort: NonNullable<AgentParameters["reasoning"]>["effort"] | undefined
): string | undefined =>
  effort === undefined ? undefined : harnessEffortFlag("pi", effort);

const buildPiAcpEnvironment = (
  baseEnv: NodeJS.ProcessEnv,
  invokeEnv: Readonly<Record<string, string | undefined>>
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...invokeEnv,
  };
  env[PI_CODING_AGENT_DIR_ENV] = resolvePiAgentDir(env);
  env.ROUTEKIT_EVAL_GATEWAY_SESSION_ID ??= crypto.randomUUID();
  return env;
};

const piRetrySupport = {
  affordableMaxTokens: parseAffordableMaxTokens,
  // Returns the cap actually written, so a caller reporting the retry to a user
  // cannot drift from the figure pi will be held to.
  applyAffordableCap: async (
    env: NodeJS.ProcessEnv,
    modelId: string,
    affordable: number
  ): Promise<number> => {
    const maxTokens = clampMaxTokensToAfford(affordable);
    await ensurePiGatewayAttribution({
      env: buildPiAcpEnvironment(env, {}),
      modelCap: {
        maxTokens,
        modelId,
      },
      modelSlug: modelId,
    });
    return maxTokens;
  },
  describeCreditShortfall,
  resolveModelId: (
    requested: string | null | undefined,
    env: NodeJS.ProcessEnv
  ): string =>
    piGatewayModelId(
      forceGatewayModelSlug(resolvePiRuntimeModel(requested, env))
    ),
};

const preparePiRuntime = Effect.fn("PiAcp.prepareRuntime")(function* (input: {
  readonly contextWindow: number | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly model: string;
}) {
  const forcedModel = forceGatewayModelSlug(input.model);
  const webToolsExtensionPath = yield* Effect.promise(() =>
    setUpWebToolsExtension(input.env)
  );
  yield* Effect.promise(() =>
    ensurePiCompactionSettings(input.env, input.contextWindow)
  );
  yield* Effect.promise(() =>
    ensurePiGatewayAttribution({
      env: input.env,
      modelCap: resolvePiMaxTokensCap(forcedModel, input.env),
      modelSlug: forcedModel,
    })
  );
  const attributionExtensionPath = yield* Effect.promise(() =>
    materializeGatewaySessionAttributionExtension(input.env)
  );
  return {
    attributionExtensionPath,
    forcedModel,
    webToolsExtensionPath,
  };
});

const resolvePiBinary = async (
  config: PiHarnessConfig,
  env: NodeJS.ProcessEnv
): Promise<string> => {
  const binary = await Effect.runPromise(
    Effect.scoped(
      ensurePiBinary({
        autoInstall: config.autoInstall,
        binary: config.binary,
        env,
        missingBinary: config.binaryRequirement,
      }).pipe(Effect.provide(NodeServicesLayer))
    )
  );
  if (Result.isFailure(binary)) {
    throw new Error(binary.failure);
  }
  return binary.success;
};

const extensionArgs = (extensionPath: string | undefined): readonly string[] =>
  extensionPath === undefined ? [] : ["--extension", extensionPath];

const preparePiAcpLaunch = async (
  options: PiAcpPrepareOptions
): Promise<PiAcpLaunch> => {
  const env = buildPiAcpEnvironment(globalThis.process.env, options.env);
  const config = readPiHarnessConfig(env);
  const model = resolvePiRuntimeModel(options.model, env);
  const prepared = await Effect.runPromise(
    preparePiRuntime({
      contextWindow: options.contextWindow,
      env,
      model,
    })
  );
  const binary = await resolvePiBinary(config, env);
  const thinkingLevel = piThinkingLevel(options.parameters?.reasoning?.effort);
  const extensionPath = await materializeAskUserExtension(env);
  const bashSummaryExtensionPath = await materializeBashSummaryExtension(env);

  const promptFiles = await writePiPromptFiles({
    prompt: "",
    systemPrompt: options.systemPrompt,
    type: "invokeOptions",
  });
  try {
    const args = [
      "--mode",
      "rpc",
      ...(config.extraArgs ?? []),
      "--skill",
      join(options.cwd, ".agents", "skills"),
      ...(options.extraSkillDirs ?? []).flatMap((dir) => ["--skill", dir]),
      ...extensionArgs(extensionPath),
      ...extensionArgs(bashSummaryExtensionPath),
      ...extensionArgs(prepared.attributionExtensionPath),
      ...(promptFiles?.systemPromptPath === undefined
        ? []
        : ["--system-prompt", promptFiles.systemPromptPath]),
      ...extensionArgs(prepared.webToolsExtensionPath),
      "--model",
      prepared.forcedModel,
      ...(thinkingLevel === undefined ? [] : ["--thinking", thinkingLevel]),
    ];
    const invocation = await resolvePiInvocation({
      args,
      binary,
      env,
    });
    return {
      args: invocation.args,
      command: invocation.binary,
      cwd: options.cwd,
      dispose: () => removePiPromptFiles(promptFiles),
      env: {
        ...options.env,
        [PI_CODING_AGENT_DIR_ENV]: env[PI_CODING_AGENT_DIR_ENV],
        ROUTEKIT_EVAL_GATEWAY_SESSION_ID: env.ROUTEKIT_EVAL_GATEWAY_SESSION_ID,
      },
    };
  } catch (error) {
    await removePiPromptFiles(promptFiles);
    throw error;
  }
};

export {
  buildPiAcpEnvironment,
  piRetrySupport,
  preparePiAcpLaunch,
  preparePiRuntime,
  piThinkingLevel,
  resolvePiRuntimeModel,
};
export type { PiAcpLaunch, PiAcpPrepareOptions };
