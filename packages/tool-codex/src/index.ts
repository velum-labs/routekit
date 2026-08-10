import { gatewayOpenAiBaseUrl } from "@velum-labs/routekit-runtime";
import type { ToolIntegration } from "@velum-labs/routekit-tools";

import { codexDriverConfigSchema, createCodexDriver } from "./driver.js";
import { codexLaunchConfigToml, launchCodex } from "./launch.js";

const driver = createCodexDriver();

export const codexTool: ToolIntegration = {
  id: "codex",
  displayName: "Codex",
  pickerHint: "OpenAI Codex CLI",
  binary: "codex",
  packageName: "@velum-labs/routekit-tool-codex",
  installHint: "install the Codex CLI: https://github.com/openai/codex",
  authSummary: "Codex uses RouteKit's OpenAI-compatible gateway provider.",
  setupSnippet: ({ gatewayUrl, model = "gateway-model" }) =>
    codexLaunchConfigToml({
      gatewayUrl,
      defaultModel: model
    }),
  launch: launchCodex,
  driver: {
    kind: driver.kind,
    driver,
    configForRoute: (route) =>
      codexDriverConfigSchema.parse({
        model: route.model,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        provider: {
          baseUrl: gatewayOpenAiBaseUrl(route.gatewayUrl),
          ...(route.authToken !== undefined ? { apiKey: route.authToken } : {})
        }
      })
  },
  capabilities: {
    streaming: "full",
    tools: "full",
    images: "degraded",
    reasoning_controls: "full"
  }
};

export type { CodexDriverConfig } from "./driver.js";
export {
  codexDriverConfigSchema,
  createCodexDriver
} from "./driver.js";
export type {
  CodexInstallInput,
  CodexInstallOwner,
  CodexInstallProfile,
  CodexInstallResult
} from "./install.js";
export {
  codexIntegrationBlock,
  codexIntegrationConfigPath,
  installCodexIntegration,
  uninstallCodexIntegration
} from "./install.js";
export type { CodexAgentRole, CodexModelPreset } from "./launch.js";
export {
  codexAgentRoles,
  codexAgentRoleToml,
  codexAuthPath,
  codexCatalogEntries,
  codexLaunchConfigToml,
  codexListedStockSlugs,
  codexModelCatalogJson,
  codexPersistentModelCatalogJson,
  codexProfileFiles,
  codexProfileFileToml,
  hasCodexLogin,
  isCodexConfigFailure,
  launchCodex,
  readCodexCatalogTemplate,
  readCodexHomeModelsCache,
  readCodexModelsCache
} from "./launch.js";
