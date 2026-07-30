/**
 * Canonical registry of the coding-tool integrations shipped by RouteKit.
 *
 * Add a new integration to `toolIntegrations`; consumers receive it through
 * `toolRegistry` without maintaining their own package imports or lists.
 */
import { claudeTool } from "@velum-labs/routekit-tool-claude";
import { codexTool } from "@velum-labs/routekit-tool-codex";
import { cursorTool } from "@velum-labs/routekit-tool-cursor";
import { opencodeTool } from "@velum-labs/routekit-tool-opencode";
import type { ToolIntegration, ToolRegistry } from "@velum-labs/routekit-tools";
import { createToolRegistry } from "@velum-labs/routekit-tools";

export type {
  ClaudeInstallInput,
  ClaudeInstallOwner,
  ClaudeInstallResult
} from "@velum-labs/routekit-tool-claude";
export {
  claudeIntegrationConfigPath,
  installClaudeIntegration,
  uninstallClaudeIntegration
} from "@velum-labs/routekit-tool-claude";
export type {
  CodexInstallInput,
  CodexInstallOwner,
  CodexInstallProfile,
  CodexInstallResult
} from "@velum-labs/routekit-tool-codex";
export {
  codexIntegrationBlock,
  codexIntegrationConfigPath,
  installCodexIntegration,
  uninstallCodexIntegration
} from "@velum-labs/routekit-tool-codex";

export const toolIntegrations: readonly ToolIntegration[] = [
  codexTool,
  claudeTool,
  cursorTool,
  opencodeTool
];

export const toolRegistry: ToolRegistry = createToolRegistry(toolIntegrations);
