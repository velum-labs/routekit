import { Redacted } from "effect";

import { evalInferenceOrigin } from "../../../../../../../host-env.ts";

import type { ClaudeAdapterConfig } from "../config.ts";
import type { ReasoningEffort } from "../../../../../contracts/internal/src/author-schemas/reasoning-effort.ts";

import { harnessEffortFlag } from "../../../../../contracts/internal/src/author-schemas/reasoning-effort.ts";
import { readPersonaEnv } from "../../../../../contracts/internal/src/cli/intern-launcher-env.ts";
import { ROUTEKIT_EVAL_BEARER_TOKEN_ENV } from "../../../../../contracts/internal/src/gateway-auth.ts";

const claudeEffort = (
  effort: ReasoningEffort | undefined
): string | undefined =>
  effort === undefined ? undefined : harnessEffortFlag("claude", effort);

interface ClaudeProcessConfig {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, Redacted.Redacted>>;
}

const CLAUDE_BUNDLED_SKILLS_DISABLE_ENV = "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS";

type ClaudeSessionStartup =
  | { readonly type: "create"; readonly sessionId: string }
  | { readonly type: "load"; readonly sessionId: string };

const mergeCustomHeaders = (
  existing: string | undefined,
  sessionId: string
): string => {
  const lines = existing?.trim().split(/\r?\n/u) ?? [];
  const hasSessionHeader = lines.some((line) => {
    const separator = line.indexOf(":");
    return (
      separator > 0 &&
      line.slice(0, separator).trim().toLowerCase() === "x-session-id"
    );
  });
  return hasSessionHeader
    ? lines.join("\n")
    : [...lines, `X-Session-Id: ${sessionId}`]
        .filter((line) => line.length > 0)
        .join("\n");
};

const buildClaudeProcessEnv = (
  gatewayApiKey: Redacted.Redacted,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env
): ClaudeProcessConfig["env"] => ({
  ANTHROPIC_API_KEY: Redacted.make(""),
  ANTHROPIC_AUTH_TOKEN: gatewayApiKey,
  ANTHROPIC_BASE_URL: Redacted.make(
    baseEnv.ANTHROPIC_BASE_URL?.trim() || evalInferenceOrigin(baseEnv),
  ),
  IS_SANDBOX: Redacted.make("1"),
  [ROUTEKIT_EVAL_BEARER_TOKEN_ENV]: gatewayApiKey,
  ...(readPersonaEnv(baseEnv) !== "code" ||
  baseEnv[CLAUDE_BUNDLED_SKILLS_DISABLE_ENV]?.trim()
    ? {}
    : {
        [CLAUDE_BUNDLED_SKILLS_DISABLE_ENV]: Redacted.make("1"),
      }),
});

interface ClaudeProcessInput {
  readonly config: ClaudeAdapterConfig;
  readonly gatewayApiKey: Redacted.Redacted;
  readonly startup: ClaudeSessionStartup;
  readonly inheritedCustomHeaders?: string | undefined;
}

function buildClaudeProcess(input: ClaudeProcessInput): ClaudeProcessConfig;
function buildClaudeProcess(
  config: ClaudeAdapterConfig,
  gatewayApiKey: Redacted.Redacted,
  startup: ClaudeSessionStartup
): ClaudeProcessConfig;
function buildClaudeProcess(
  ...args:
    | [input: ClaudeProcessInput]
    | [
        config: ClaudeAdapterConfig,
        gatewayApiKey: Redacted.Redacted,
        startup: ClaudeSessionStartup,
      ]
): ClaudeProcessConfig {
  const [input, gatewayApiKey, startup] = args;
  let normalized: ClaudeProcessInput;
  if ("config" in input) {
    normalized = input;
  } else {
    if (gatewayApiKey === undefined || startup === undefined) {
      throw new Error("Claude process startup configuration is incomplete");
    }
    normalized = {
      config: input,
      gatewayApiKey,
      startup,
    };
  }
  const {
    config,
    inheritedCustomHeaders,
    gatewayApiKey: apiKey,
    startup: sessionStartup,
  } = normalized;
  const sessionId = config.gatewaySessionId ?? sessionStartup.sessionId;
  const effort = claudeEffort(config.parameters?.reasoning?.effort);
  const pluginDirArgs = (config.pluginDirs ?? []).flatMap((dir) => [
    "--plugin-dir",
    dir,
  ]);
  return {
    args: [
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      "--model",
      config.model,
      ...(effort === undefined ? [] : ["--effort", effort]),
      ...(sessionStartup.type === "create"
        ? ["--session-id", sessionStartup.sessionId]
        : ["--resume", sessionStartup.sessionId]),
      ...pluginDirArgs,
      ...(config.systemPrompt === undefined
        ? []
        : ["--system-prompt", config.systemPrompt]),
    ],
    command: config.claudeCommand,
    cwd: config.cwd,
    env: {
      ...buildClaudeProcessEnv(apiKey),
      ANTHROPIC_CUSTOM_HEADERS: Redacted.make(
        mergeCustomHeaders(inheritedCustomHeaders, sessionId)
      ),
    },
  };
}

export { buildClaudeProcess, buildClaudeProcessEnv };
export type { ClaudeSessionStartup };
