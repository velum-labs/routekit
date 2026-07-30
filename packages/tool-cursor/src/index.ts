import { cursorModelName } from "@velum-labs/routekit-contracts";
import type { ToolIntegration } from "@velum-labs/routekit-tools";

import { createCursorDriver, cursorDriverConfigSchema } from "./driver.js";
import { cursorByokBaseUrl, launchCursor } from "./launch.js";

const driver = createCursorDriver();

export const cursorTool: ToolIntegration = {
  id: "cursor",
  displayName: "Cursor",
  pickerHint: "Cursor editor via a custom OpenAI endpoint",
  packageName: "@velum-labs/routekit-tool-cursor",
  installHint: "install Cursor: https://cursor.com",
  authSummary:
    "Cursor uses its own login plus the gateway's OpenAI-compatible /v1/cursor endpoint.",
  setupSnippet: ({ gatewayUrl, model = "gateway-model" }) =>
    `Cursor Settings -> Models -> Override OpenAI Base URL: ${cursorByokBaseUrl(gatewayUrl)} (model name: ${cursorModelName(model)})`,
  launch: launchCursor,
  driver: {
    kind: driver.kind,
    driver,
    // cursor-agent talks to Cursor's own backend, not the gateway, so a
    // RouteKit route contributes no endpoint here.
    configForRoute: (route) => cursorDriverConfigSchema.parse({ model: route.model })
  },
  capabilities: {
    streaming: "full",
    tools: "full",
    images: "degraded",
    reasoning_controls: "degraded"
  }
};

export type { CursorDriverConfig } from "./driver.js";
export { createCursorDriver, cursorDriverConfigSchema } from "./driver.js";
export {
  cursorByokBaseUrl,
  cursorInstructions,
  launchCursor
} from "./launch.js";
export {
  CURSOR_AGENTS_DIRNAME,
  cursorSubagentMarkdown,
  scaffoldCursorSubagents
} from "./subagents.js";
