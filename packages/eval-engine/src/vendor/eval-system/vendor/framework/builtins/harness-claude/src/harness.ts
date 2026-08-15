import type { Effect, Option } from "effect";
import type {
  AgentHarness,
  AgentRuntimeEvent,
  HarnessInvokeOptions,
  ReasoningEffort,
} from "../../routekit-eval/src/index.ts";
import type { HarnessProcessBinaryRequirement } from "../../routekit-eval/src/process.ts";

import { Stream } from "effect";
import { harnessEffortFlag, hasEmittedTerminalEvent } from "../../routekit-eval/src/index.ts";
import { log } from "../../routekit-eval/src/logger.ts";
import {
  ROUTEKIT_EVAL_BEARER_TOKEN_ENV,
  ROUTEKIT_EVAL_GATEWAY_ATTRIBUTION_HEADERS,
  missingGatewayKeyEvent,
} from "../../routekit-eval/src/gateway-auth.ts";
import {
  detectMissingHarnessProcessBinary,
  mergeAnthropicCustomHeaders,
  normalizeEnvValue,
  parseBooleanEnv,
  parseTimeoutMs,
  streamJsonlProcess,
  withOutputSchemaInstruction,
} from "../../routekit-eval/src/process.ts";

import { formatSafeErrorDiagnostic } from "../../../utils/core/src/error-formatting.ts";

import type { ClaudeNormalizeState } from "./normalizer.ts";

import { resolveMcpConfigPath } from "./mcp-config.ts";
import {
  finalizeClaudeNormalizeState,
  initialClaudeNormalizeState,
  normalizeClaudeJsonLine,
} from "./normalizer.ts";
import {
  claudeProcessOutcome,
  processResultError,
} from "./process-result-error.ts";

const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
const ANTHROPIC_BASE_URL_ENV = "ANTHROPIC_BASE_URL";
const ANTHROPIC_CUSTOM_HEADERS_ENV = "ANTHROPIC_CUSTOM_HEADERS";
const CLAUDE_BINARY = "claude";
const CLAUDE_PACKAGE = "@anthropic-ai/claude-code";
const DANGEROUSLY_SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";
const DEFAULT_ANTHROPIC_BASE_URL = "http://127.0.0.1:8080";
export const CLAUDE_DEFAULT_MODEL = "~anthropic/claude-sonnet-latest";
const CLAUDE_COMPACTION_PROMPT = "/compact";
const EMPTY_COUNT = 0;
const INCLUDE_PARTIAL_MESSAGES_FLAG = "--include-partial-messages";
const IS_SANDBOX_ENV = "IS_SANDBOX";
const MCP_CONFIG_FLAG = "--mcp-config";
const MODEL_FLAG = "--model";
const ROUTEKIT_EVAL_CLAUDE_BIN_ENV = "ROUTEKIT_EVAL_CLAUDE_BIN";
const ROUTEKIT_EVAL_CLAUDE_DISABLE_TOOLS_ENV = "ROUTEKIT_EVAL_CLAUDE_DISABLE_TOOLS";
const ROUTEKIT_EVAL_CLAUDE_TIMEOUT_MS_ENV = "ROUTEKIT_EVAL_CLAUDE_TIMEOUT_MS";
const OUTPUT_FORMAT_FLAG = "--output-format";
const PLUGIN_DIR_FLAG = "--plugin-dir";
const PRINT_FLAG = "-p";
const RESUME_FLAG = "--resume";
const STREAM_JSON_FORMAT = "stream-json";
const SYSTEM_PROMPT_FLAG = "--system-prompt";
const TOOLS_FLAG = "--tools";
const VERBOSE_FLAG = "--verbose";

interface ClaudeHarnessConfig {
  readonly binary: string;
  readonly binaryRequirement: HarnessProcessBinaryRequirement;
  readonly disableTools: boolean;
  readonly timeoutMs?: number | undefined;
}

const defaultClaudeArgsConfig = {
  disableTools: false,
} satisfies Pick<ClaudeHarnessConfig, "disableTools">;

const CLAUDE_BINARY_REQUIREMENT = {
  binaryEnvVar: ROUTEKIT_EVAL_CLAUDE_BIN_ENV,
  installCommand: `bun add -g --trust ${CLAUDE_PACKAGE}`,
} satisfies HarnessProcessBinaryRequirement;

const applyEnvDefaults = (
  env: NodeJS.ProcessEnv,
  defaults: Record<string, string>
): void => {
  for (const [name, value] of Object.entries(defaults)) {
    if (normalizeEnvValue(env[name]) === undefined) {
      env[name] = value;
    }
  }
};

const ANTHROPIC_MODEL_PREFIXES = ["anthropic/", "~anthropic/"] as const;

const isAnthropicModel = (model: string): boolean =>
  ANTHROPIC_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));

const resolveClaudeModel = (model: string | null | undefined): string => {
  const requested = model?.trim() ?? "";
  return requested.length > EMPTY_COUNT ? requested : CLAUDE_DEFAULT_MODEL;
};

// Every env var the harness defaults, in one place. A user-set value always
// wins. The Gateway-only entries (prompt economy, model tiers claude only
// defaults for api.anthropic.com) apply only on the default Gateway host.
const claudeEnvDefaults = (
  baseUrl: string,
  options: {
    readonly contextWindow?: number | undefined;
    readonly disableBundledSkills?: boolean | undefined;
    readonly model?: string | null | undefined;
  }
): Record<string, string> => ({
  [ANTHROPIC_BASE_URL_ENV]: DEFAULT_ANTHROPIC_BASE_URL,
  ...(options.contextWindow === undefined
    ? {}
    : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(options.contextWindow) }),
  ...(options.disableBundledSkills === true
    ? { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" }
    : {}),
  ...(baseUrl === DEFAULT_ANTHROPIC_BASE_URL &&
  isAnthropicModel(resolveClaudeModel(options.model))
    ? { ENABLE_TOOL_SEARCH: "true" }
    : {}),
  ...(baseUrl === DEFAULT_ANTHROPIC_BASE_URL
    ? {
        CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: "1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "~anthropic/claude-haiku-latest",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "~anthropic/claude-sonnet-latest",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "~anthropic/claude-opus-latest",
      }
    : {}),
});

const shouldRequireGatewayKey = (env: NodeJS.ProcessEnv): boolean => {
  const baseUrl = normalizeEnvValue(env[ANTHROPIC_BASE_URL_ENV]);
  return baseUrl === undefined || baseUrl === DEFAULT_ANTHROPIC_BASE_URL;
};

const claudeEffort = (
  effort: ReasoningEffort | undefined
): string | undefined =>
  effort === undefined ? undefined : harnessEffortFlag("claude", effort);

const buildClaudeArgs = (
  options: HarnessInvokeOptions,
  config: Pick<ClaudeHarnessConfig, "disableTools"> = defaultClaudeArgsConfig,
  injected: { readonly mcpConfigPath?: string | undefined } = {}
): readonly string[] => {
  const args = [
    PRINT_FLAG,
    VERBOSE_FLAG,
    OUTPUT_FORMAT_FLAG,
    STREAM_JSON_FORMAT,
    INCLUDE_PARTIAL_MESSAGES_FLAG,
    DANGEROUSLY_SKIP_PERMISSIONS_FLAG,
  ];

  // A project `mcp.json` reaches claude ONLY via an explicit `--mcp-config`: in
  // headless `-p` mode claude leaves a cwd-discovered `.mcp.json` server
  // "pending" behind its approval gate and silently drops it, whereas a
  // `--mcp-config`-sourced server connects with no approval step. The caller
  // resolves the path (and confirms it exists) before invoking.
  if (injected.mcpConfigPath !== undefined) {
    args.push(MCP_CONFIG_FLAG, injected.mcpConfigPath);
  }

  // claude has no append-system-prompt flag, so fold the structured-output
  // instruction into the single system prompt it accepts.
  const systemPrompt = withOutputSchemaInstruction(
    options.systemPrompt,
    options.outputSchema
  );
  if (systemPrompt !== undefined) {
    args.push(SYSTEM_PROMPT_FLAG, systemPrompt);
  }

  if (options.sessionId) {
    args.push(RESUME_FLAG, options.sessionId);
  }

  // A framework-owned skill directory (RFC 0004 code.md): `routekit-eval code`'s
  // built-in code-practice skills load this way instead of being
  // materialized into the project's own `.claude/skills`. No `plugin.json`
  // manifest is required — a bare `skills/<name>/SKILL.md` layout loads.
  for (const extraSkillDir of options.extraSkillDirs ?? []) {
    args.push(PLUGIN_DIR_FLAG, extraSkillDir);
  }

  // Always emit `--model` (see RFC 0006 claude rule 5): the caller's catalog
  // id when non-blank, otherwise the Gateway default. Omitting the flag
  // would let claude run its compiled-in upstream default and report the
  // upstream Anthropic model id instead of an Gateway catalog id.
  const requestedModel =
    typeof options.model === "string" ? options.model.trim() : "";
  const effort = claudeEffort(options.parameters?.reasoning?.effort);
  args.push(
    MODEL_FLAG,
    requestedModel.length > EMPTY_COUNT ? requestedModel : CLAUDE_DEFAULT_MODEL,
    ...(effort === undefined ? [] : ["--effort", effort])
  );

  if (config.disableTools) {
    args.push(TOOLS_FLAG, "");
  }

  return args;
};

// Attribute Gateway-routed activity to routekit-eval. Skip when a custom base URL is
// set, since those headers only mean something to Gateway.
const applyGatewayAttributionHeaders = (env: NodeJS.ProcessEnv): void => {
  if (env[ANTHROPIC_BASE_URL_ENV] !== DEFAULT_ANTHROPIC_BASE_URL) {
    return;
  }
  const customHeaders = mergeAnthropicCustomHeaders(
    env[ANTHROPIC_CUSTOM_HEADERS_ENV],
    ROUTEKIT_EVAL_GATEWAY_ATTRIBUTION_HEADERS
  );
  if (customHeaders !== undefined) {
    env[ANTHROPIC_CUSTOM_HEADERS_ENV] = customHeaders;
  }
};

const applyGatewaySessionHeader = (env: NodeJS.ProcessEnv): void => {
  if (env[ANTHROPIC_BASE_URL_ENV] !== DEFAULT_ANTHROPIC_BASE_URL) {
    return;
  }
  const sessionId =
    normalizeEnvValue(env.ROUTEKIT_EVAL_GATEWAY_SESSION_ID) ?? crypto.randomUUID();
  env.ROUTEKIT_EVAL_GATEWAY_SESSION_ID = sessionId;
  const customHeaders = mergeAnthropicCustomHeaders(
    env[ANTHROPIC_CUSTOM_HEADERS_ENV],
    [["X-Session-Id", sessionId]]
  );
  if (customHeaders !== undefined) {
    env[ANTHROPIC_CUSTOM_HEADERS_ENV] = customHeaders;
  }
};

const buildClaudeProcessEnv = (
  baseEnv: NodeJS.ProcessEnv,
  invokeEnv: Record<string, string | undefined> | undefined = {},
  options: {
    readonly contextWindow?: number | undefined;
    readonly disableBundledSkills?: boolean | undefined;
    readonly model?: string | null | undefined;
  } = {}
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...invokeEnv,
  };
  const gatewayKey = normalizeEnvValue(env[ROUTEKIT_EVAL_BEARER_TOKEN_ENV]);

  if (gatewayKey !== undefined) {
    env[ROUTEKIT_EVAL_BEARER_TOKEN_ENV] = gatewayKey;
    env[ANTHROPIC_AUTH_TOKEN_ENV] = gatewayKey;
  }

  env[ANTHROPIC_API_KEY_ENV] = "";

  const baseUrl =
    normalizeEnvValue(env[ANTHROPIC_BASE_URL_ENV]) ??
    DEFAULT_ANTHROPIC_BASE_URL;
  applyEnvDefaults(env, claudeEnvDefaults(baseUrl, options));

  // Claude refuses --dangerously-skip-permissions when running as root unless
  // it believes it is sandboxed; routekit-eval owns the sandbox, so assert it.
  env[IS_SANDBOX_ENV] = "1";

  applyGatewayAttributionHeaders(env);
  applyGatewaySessionHeader(env);

  return env;
};

const runClaudeProcess = (input: {
  readonly args: readonly string[];
  readonly binary: string;
  readonly cwd?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly missingBinary: HarnessProcessBinaryRequirement;
  readonly prompt: string;
  readonly timeoutMs?: number | undefined;
}): Stream.Stream<AgentRuntimeEvent, Error> =>
  streamJsonlProcess<ClaudeNormalizeState, AgentRuntimeEvent>({
    ...input,
    finalize: (state, result) => {
      const error = processResultError(result, state.emittedTerminalEvent);
      if (error !== undefined) {
        // The failure that goes out carries the code's fixed summary, so this
        // is the only place the process's own stderr tail is recorded at all.
        // Redacted on the way: the tail is the binary's own output and it
        // echoes environment configuration and provider error bodies.
        log.child("claude").error(formatSafeErrorDiagnostic(error));
      }
      return finalizeClaudeNormalizeState(
        state,
        claudeProcessOutcome(result, error)
      );
    },
    initialState: initialClaudeNormalizeState(),
    normalizeLine: normalizeClaudeJsonLine,
    shouldSkipFinalize: hasEmittedTerminalEvent,
  });

const readClaudeHarnessConfig = (
  env: NodeJS.ProcessEnv
): ClaudeHarnessConfig => ({
  binary: normalizeEnvValue(env[ROUTEKIT_EVAL_CLAUDE_BIN_ENV]) ?? CLAUDE_BINARY,
  binaryRequirement: CLAUDE_BINARY_REQUIREMENT,
  disableTools: parseBooleanEnv(env[ROUTEKIT_EVAL_CLAUDE_DISABLE_TOOLS_ENV]),
  timeoutMs: parseTimeoutMs(env[ROUTEKIT_EVAL_CLAUDE_TIMEOUT_MS_ENV]),
});

const promptClaude = async function* (
  options: HarnessInvokeOptions
): AsyncGenerator<AgentRuntimeEvent, void, unknown> {
  const env = buildClaudeProcessEnv(
    process.env,
    {
      ...options.env,
      ...(options.sessionId === undefined
        ? {}
        : { ROUTEKIT_EVAL_GATEWAY_SESSION_ID: options.sessionId }),
    },
    {
      contextWindow: options.contextWindow,
      disableBundledSkills: options.disableBundledSkills,
      model: options.model,
    }
  );
  if (
    shouldRequireGatewayKey(env) &&
    normalizeEnvValue(env[ROUTEKIT_EVAL_BEARER_TOKEN_ENV]) === undefined
  ) {
    yield missingGatewayKeyEvent();
    return;
  }

  const config = readClaudeHarnessConfig(env);
  const mcpConfigPath = await resolveMcpConfigPath(options.cwd);
  const events = runClaudeProcess({
    args: buildClaudeArgs(
      options,
      config,
      mcpConfigPath === undefined ? {} : { mcpConfigPath }
    ),
    binary: config.binary,
    cwd: options.cwd,
    env,
    missingBinary: config.binaryRequirement,
    prompt: options.prompt,
    timeoutMs: config.timeoutMs,
  });

  for await (const event of Stream.toAsyncIterable(events)) {
    yield event;
  }
};

const initClaude: AgentHarness["init"] = (registrar) => {
  registrar.registerClose(() => Promise.resolve());
  registrar.setDefaultModel(CLAUDE_DEFAULT_MODEL);
  registrar.registerCompaction((options) =>
    promptClaude({
      ...options,
      prompt: CLAUDE_COMPACTION_PROMPT,
    })
  );
  registrar.registerPrompt(promptClaude);
};

export const claudeHarness = {
  init: initClaude,
  name: "claude",
} satisfies AgentHarness;
export const readClaudeHarnessAvailabilityDiagnostic = (
  env: NodeJS.ProcessEnv
): Effect.Effect<Option.Option<string>, Error> => {
  const config = readClaudeHarnessConfig(env);
  return detectMissingHarnessProcessBinary({
    binary: config.binary,
    env,
    missingBinary: config.binaryRequirement,
  });
};
export {
  CLAUDE_COMPACTION_PROMPT,
  resolveMcpConfigPath,
  ROUTEKIT_EVAL_CLAUDE_BIN_ENV,
  buildClaudeArgs,
  buildClaudeProcessEnv,
  claudeEffort,
};
