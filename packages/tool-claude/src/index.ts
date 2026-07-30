import { trimTrailingSlashes } from "@velum-labs/routekit-runtime";
import type { ToolIntegration } from "@velum-labs/routekit-tools";

import { claudeDriverConfigSchema, createClaudeDriver } from "./driver.js";
import { claudeEnv, launchClaude } from "./launch.js";

const driver = createClaudeDriver();

export const claudeTool: ToolIntegration = {
  id: "claude",
  aliases: ["claude-code"],
  displayName: "Claude Code",
  pickerHint: "Claude Code",
  binary: "claude",
  packageName: "@velum-labs/routekit-tool-claude",
  installHint: "install Claude Code: https://docs.anthropic.com/en/docs/claude-code/overview",
  authSummary: "Claude Code uses the gateway's Anthropic-compatible surface.",
  setupSnippet: ({ gatewayUrl, model = "gateway-model" }) =>
    [
      `ANTHROPIC_BASE_URL=${trimTrailingSlashes(gatewayUrl)}`,
      "ANTHROPIC_AUTH_TOKEN=routekit",
      `ANTHROPIC_MODEL=${model}`
    ].join("\n"),
  session: { status: "resumable", removal: "forget-only" },
  launch: launchClaude,
  driver: {
    kind: driver.kind,
    driver,
    configForRoute: (route) =>
      claudeDriverConfigSchema.parse({ model: route.model, baseUrl: route.gatewayUrl })
  },
  capabilities: {
    streaming: "full",
    tools: "full",
    images: "full",
    reasoning_controls: "degraded"
  }
};

export type {
  ClaudeDriverConfig,
  ClaudeDriverOptions,
  ClaudeQueryFn
} from "./driver.js";
export { claudeDriverConfigSchema, createClaudeDriver } from "./driver.js";
export type {
  ClaudeInstallInput,
  ClaudeInstallOwner,
  ClaudeInstallResult
} from "./install.js";
export {
  installClaudeIntegration,
  uninstallClaudeIntegration
} from "./install.js";
export {
  claudeAgentsJson,
  claudeEnv,
  claudeLaunchArgs,
  claudeResumeCursor,
  claudeResumeSessionId,
  launchClaude,
  prepareClaudeLaunch
} from "./launch.js";
