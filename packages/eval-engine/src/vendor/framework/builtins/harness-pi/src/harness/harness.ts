import type {
  AgentHarness,
  AgentRuntimeEvent,
  HarnessInvokeOptions,
} from "../../../ori/src/index.ts";
import type { HarnessProcessBinaryRequirement } from "../../../ori/src/process.ts";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Option, Result, Stream } from "effect";
import { agentFailure, hasEmittedTerminalEvent } from "../../../ori/src/index.ts";
import { log } from "../../../ori/src/logger.ts";
import {
  OPENROUTER_API_KEY_ENV,
  missingOpenRouterKeyEvent,
} from "../../../ori/src/openrouter-auth.ts";
import {
  detectMissingHarnessProcessBinary,
  normalizeEnvValue,
  parseTimeoutMs,
  streamJsonlProcess,
} from "../../../ori/src/process.ts";

import type { PiNormalizeState } from "../events/normalizer.ts";
import type { PiMaxTokensCap } from "../model/model.ts";

import { ensurePiCompactionSettings } from "../compaction/pi-compaction-settings.ts";
import {
  finalizePiNormalizeState,
  initialPiNormalizeState,
  normalizePiJsonLine,
} from "../events/normalizer.ts";
import { setUpMcpExtension } from "../mcp/mcp-setup.ts";
import {
  PI_FALLBACK_DEFAULT_MODEL,
  piOpenRouterModelId,
  readPiDefaultModel,
  resolvePiMaxTokensCap,
  resolvePiModel,
} from "../model/model.ts";
import {
  ensurePiOpenRouterAttribution,
  PI_CODING_AGENT_DIR_ENV,
  resolvePiAgentDir,
} from "../openrouter-attribution/openrouter-attribution.ts";
import { materializeOpenRouterSessionAttributionExtension } from "../openrouter-session-attribution/openrouter-session-attribution-setup.ts";
import {
  ensurePiBinary,
  ORI_PI_BIN_ENV,
  PI_BINARY,
  PI_BINARY_REQUIREMENT,
} from "../pi-install/pi-install.ts";
import { setUpWebToolsExtension } from "../web-tools/web-tools-setup.ts";

import type { PiRuntime } from "./pi-runtime.ts";

import { runClampableAttempt } from "./clamp-retry.ts";
import { buildPiArgs } from "./pi-args.ts";
import { resolvePiInvocation } from "./pi-runtime.ts";
import {
  piProcessFailure,
  processResultError,
  redactedProcessDiagnostic,
} from "./process-failure.ts";
import { removePiPromptFiles, writePiPromptFiles } from "./prompt-files.ts";

const EMPTY_COUNT = 0;
const ORI_PI_EXTRA_ARGS_ENV = "ORI_PI_EXTRA_ARGS";
const ORI_PI_TIMEOUT_MS_ENV = "ORI_PI_TIMEOUT_MS";
const ORI_OPENROUTER_SESSION_ID_ENV = "ORI_OPENROUTER_SESSION_ID";

const WHITESPACE_PATTERN = /\s+/u;

// How many times to re-run pi with a lower max_tokens after an OpenRouter 402
// credit/budget rejection before surfacing the failure. pi builds the request,
// so ori cannot clamp in place — it lowers the models.json cap and re-invokes.
const MAX_CLAMP_RETRIES = 3;
const materializePiExtensions = async (
  env: NodeJS.ProcessEnv
): Promise<{
  readonly mcpExtensionPath?: string | undefined;
  readonly openRouterSessionAttributionExtensionPath?: string | undefined;
  readonly webToolsExtensionPath?: string | undefined;
}> => {
  const openRouterSessionAttributionExtensionPath =
    await materializeOpenRouterSessionAttributionExtension(env);
  return {
    mcpExtensionPath: await setUpMcpExtension(env),
    openRouterSessionAttributionExtensionPath,
    webToolsExtensionPath: await setUpWebToolsExtension(env),
  };
};

interface PiHarnessConfig {
  readonly autoInstall: boolean;
  readonly binary: string;
  readonly binaryRequirement: HarnessProcessBinaryRequirement;
  readonly defaultModel?: string | undefined;
  readonly extraArgs?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
}

const buildPiProcessEnv = (
  baseEnv: NodeJS.ProcessEnv,
  invokeEnv: Record<string, string | undefined> | undefined = {}
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...invokeEnv,
  };
  env[PI_CODING_AGENT_DIR_ENV] = resolvePiAgentDir(env);
  return env;
};

// `effectiveRuntime` is the runtime pi ACTUALLY ran under (from
// `resolvePiInvocation`). Pi always runs under Node; the ERR_MODULE_NOT_FOUND
// hint keys off that real runtime.
const runPiProcess = (input: {
  readonly args: readonly string[];
  readonly binary: string;
  readonly cwd?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly missingBinary: HarnessProcessBinaryRequirement;
  readonly prompt: string;
  readonly effectiveRuntime: PiRuntime;
  readonly timeoutMs?: number | undefined;
}): Stream.Stream<AgentRuntimeEvent, Error> => {
  const { effectiveRuntime, ...processInput } = input;
  return streamJsonlProcess<PiNormalizeState, AgentRuntimeEvent>({
    ...processInput,
    finalize: (state, result) => {
      const error = processResultError(result, effectiveRuntime);
      if (error !== undefined) {
        // The failure that goes out carries the code's fixed summary, so this
        // is the only place the stderr tail and the runtime hint naming the
        // broken install are recorded at all. Redacted on the way: the tail is
        // Pi's own output and it echoes request URLs and provider bodies.
        log.child("pi").error(redactedProcessDiagnostic(error));
      }
      return finalizePiNormalizeState(
        state,
        error === undefined
          ? { ok: true }
          : {
              failure: piProcessFailure({
                ...(result.exitCode === null
                  ? {}
                  : { exitCode: result.exitCode }),
                message: error,
                missingBinary: result.missingBinary,
                timedOut: result.timedOut,
              }),
              ok: false,
            }
      );
    },
    initialState: initialPiNormalizeState({ prompt: input.prompt }),
    normalizeLine: normalizePiJsonLine,
    shouldSkipFinalize: hasEmittedTerminalEvent,
  });
};

const splitWhitespaceArgs = (value: string): readonly string[] =>
  value
    .split(WHITESPACE_PATTERN)
    .map((part) => part.trim())
    .filter((part) => part.length !== EMPTY_COUNT);

const readPiHarnessConfig = (env: NodeJS.ProcessEnv): PiHarnessConfig => {
  const configuredBinary = normalizeEnvValue(env[ORI_PI_BIN_ENV]);
  return {
    autoInstall: configuredBinary === undefined,
    binary: configuredBinary ?? PI_BINARY,
    binaryRequirement: PI_BINARY_REQUIREMENT,
    defaultModel: readPiDefaultModel(env),
    extraArgs: splitWhitespaceArgs(env[ORI_PI_EXTRA_ARGS_ENV] ?? ""),
    timeoutMs: parseTimeoutMs(env[ORI_PI_TIMEOUT_MS_ENV]),
  };
};

const readPiHarnessAvailabilityDiagnostic = (
  env: NodeJS.ProcessEnv
): Effect.Effect<Option.Option<string>, Error> => {
  const config = readPiHarnessConfig(env);
  // Auto-managed pi (no ORI_PI_BIN) is boot-available by construction: the
  // harness installs its own copy on first invoke, so a fresh machine must not
  // boot with a "pi missing" warning. Install failures surface at invoke time
  // with a precise message. Only an explicit ORI_PI_BIN override is probed.
  if (config.autoInstall) {
    return Effect.succeed(Option.none());
  }
  return detectMissingHarnessProcessBinary({
    binary: config.binary,
    env,
    missingBinary: config.binaryRequirement,
  });
};

interface RunAutoInstallingPiProcessInput {
  readonly args: readonly string[];
  readonly autoInstall: boolean;
  readonly binary: string;
  readonly cwd?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly missingBinary: HarnessProcessBinaryRequirement;
  readonly prompt: string;
  readonly timeoutMs?: number | undefined;
}

const rewriteAndRunPiProcess = async (
  input: RunAutoInstallingPiProcessInput
): Promise<Stream.Stream<AgentRuntimeEvent, Error>> => {
  const invocation = await resolvePiInvocation({
    args: input.args,
    binary: input.binary,
    env: input.env,
  });
  return runPiProcess({
    ...input,
    args: invocation.args,
    binary: invocation.binary,
    effectiveRuntime: invocation.effectiveRuntime,
    env: input.env,
  });
};

const runAutoInstallingPiProcess = (
  input: RunAutoInstallingPiProcessInput
): Stream.Stream<AgentRuntimeEvent, Error> =>
  Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        // PATH pi is never consulted on the auto-managed path: this uses the
        // ORI_PI_BIN override verbatim, or the ORI-owned local install's cli.js.
        const binaryResult = yield* ensurePiBinary(input);
        if (Result.isFailure(binaryResult)) {
          // The install failure names the exact path that was probed, which the
          // fixed remediation below cannot: without this the user is told to
          // reinstall Pi with no way to see what went wrong the first time.
          // Redacted like every other tail: the probed paths are the user's own.
          log
            .child("pi")
            .error(redactedProcessDiagnostic(binaryResult.failure));
          return Stream.fromIterable(
            finalizePiNormalizeState(
              initialPiNormalizeState({ prompt: input.prompt }),
              {
                failure: agentFailure({
                  code: "ORI_PI_BINARY_UNAVAILABLE",
                  message: "ORI could not start its managed Pi installation.",
                  remediation:
                    "Set ORI_PI_BIN to a working Pi executable or reinstall Pi.",
                  stage: "harness",
                }),
                ok: false,
              }
            )
          );
        }

        return yield* Effect.promise(() =>
          rewriteAndRunPiProcess({
            ...input,
            binary: binaryResult.success,
          })
        );
      })
    )
  ).pipe(Stream.provide(NodeServicesLayer));

const nextClampedCap = (
  modelId: string,
  clampTo: number,
  attempt: number
): PiMaxTokensCap => {
  log
    .child("pi")
    .warn(
      `OpenRouter rejected max_tokens (402); retrying with max_tokens<=${clampTo} (attempt ${attempt + 1}/${MAX_CLAMP_RETRIES})`
    );
  return {
    modelId,
    maxTokens: clampTo,
  } satisfies PiMaxTokensCap;
};

const promptPi = async function* (
  options: HarnessInvokeOptions
): AsyncGenerator<AgentRuntimeEvent, void, unknown> {
  const env = buildPiProcessEnv(globalThis.process.env, options.env);
  env[ORI_OPENROUTER_SESSION_ID_ENV] =
    options.sessionId ??
    env[ORI_OPENROUTER_SESSION_ID_ENV] ??
    crypto.randomUUID();
  if (normalizeEnvValue(env[OPENROUTER_API_KEY_ENV]) === undefined) {
    yield missingOpenRouterKeyEvent();
    return;
  }

  const config = readPiHarnessConfig(env);
  // Resolve the same model slug buildPiArgs will pass (deterministic), so the
  // models.json cap targets exactly the model pi runs.
  const resolvedModel = resolvePiModel(
    options.model,
    config.defaultModel ?? PI_FALLBACK_DEFAULT_MODEL
  );
  const modelId = piOpenRouterModelId(resolvedModel);
  const extensions = await materializePiExtensions(env);

  let cap = resolvePiMaxTokensCap(resolvedModel, env);
  // Size pi's compaction budgets from the active model's real context
  // window before the spawn; pi re-reads settings.json on every spawn.
  await ensurePiCompactionSettings(env, options.contextWindow);
  const promptFiles = await writePiPromptFiles(options);
  try {
    for (let attempt = 0; attempt <= MAX_CLAMP_RETRIES; attempt += 1) {
      await ensurePiOpenRouterAttribution({
        env,
        modelCap: cap,
        modelSlug: resolvedModel,
      });
      const events = runAutoInstallingPiProcess({
        args: buildPiArgs(options, config, {
          ...extensions,
          promptFiles,
        }),
        autoInstall: config.autoInstall,
        binary: config.binary,
        cwd: options.cwd,
        env,
        missingBinary: config.binaryRequirement,
        prompt: options.prompt,
        timeoutMs: config.timeoutMs,
      });

      const { clampTo } = yield* runClampableAttempt(
        events,
        attempt < MAX_CLAMP_RETRIES
      );
      if (clampTo === undefined) {
        return;
      }
      cap = nextClampedCap(modelId, clampTo, attempt);
    }
  } finally {
    await removePiPromptFiles(promptFiles);
  }
};

const initPi: AgentHarness["init"] = (registrar) => {
  registrar.registerClose(() => Promise.resolve());
  registrar.setDefaultModel(readPiDefaultModel(globalThis.process.env));
  registrar.registerPrompt(promptPi);
};

export const piHarness = {
  init: initPi,
  name: "pi",
} satisfies AgentHarness;

export {
  ORI_PI_BIN_ENV,
  buildPiProcessEnv,
  ORI_OPENROUTER_SESSION_ID_ENV,
  processResultError,
  readPiHarnessAvailabilityDiagnostic,
  readPiHarnessConfig,
};
export type { PiHarnessConfig };
