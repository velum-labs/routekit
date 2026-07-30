import { resolveModelId } from "@velum-labs/routekit-config";
import type { ReasoningSelection } from "@velum-labs/routekit-contracts";
import { reasoningSelectionFromEffort } from "@velum-labs/routekit-contracts";
import type { RouterConfig } from "@velum-labs/routekit-gateway";
import { commandOnPath } from "@velum-labs/routekit-runtime";
import { toolRegistry as routekitToolRegistry } from "@velum-labs/routekit-tool-registry";
import type {
  ToolIntegration,
  ToolLaunchResult,
  ToolLaunchSpec,
  ToolModel,
  ToolModelFeatureStatus,
  ToolSessionIntent
} from "@velum-labs/routekit-tools";
import { createToolLaunchContext } from "@velum-labs/routekit-tools";

import { fetchLiveCatalog, type LiveModel } from "./catalog.js";

export { routekitToolRegistry };

function featureStatus(status: string | undefined): ToolModelFeatureStatus {
  switch (status) {
    case "supported":
      return "full";
    case "degraded":
      return "degraded";
    case "unsupported":
      return "unsupported";
    case "unknown":
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}

function liveModels(models: readonly LiveModel[]): ToolModel[] {
  return models.map((model) => {
    return {
      id: model.id,
      label: model.id,
      ...(model.provider !== undefined ? { provider: model.provider } : {}),
      features: {
        streaming: featureStatus(model.capabilities.streaming),
        tools: featureStatus(model.capabilities.tools),
        images: featureStatus(model.capabilities.images),
        reasoning_controls: featureStatus(model.capabilities.reasoning_controls)
      },
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {})
    };
  });
}

export function buildToolLaunchSpec(input: {
  config: RouterConfig;
  catalog: readonly LiveModel[];
  gatewayUrl: string;
  model?: string;
  effort?: string;
  args?: readonly string[];
  cwd?: string;
  authToken?: string;
  reasoning?: ReasoningSelection;
  session?: ToolSessionIntent;
}): ToolLaunchSpec {
  const models = liveModels(input.catalog);
  const defaultModel = resolveModelId(
    input.config,
    models.map((model) => model.id),
    input.model
  );
  const requestedEffort = input.effort;
  const selectedModel = models.find((model) => model.id === defaultModel);
  const reasoning =
    input.reasoning ??
    (requestedEffort === undefined || requestedEffort === "auto"
      ? undefined
      : (() => {
          const resolved = reasoningSelectionFromEffort(selectedModel?.reasoning, requestedEffort);
          if (!resolved.ok) {
            throw new Error(
              resolved.code === "unsupported_effort"
                ? `reasoning effort "${requestedEffort}" is not supported by model "${defaultModel}"`
                : `model "${defaultModel}" has no discovered reasoning effort controls`
            );
          }
          return resolved.selection;
        })());
  return {
    gatewayUrl: input.gatewayUrl,
    defaultModel,
    models,
    args: input.args ?? [],
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.authToken !== undefined ? { auth: { token: input.authToken } } : {}),
    ...(input.session !== undefined ? { session: input.session } : {})
  };
}

export async function launchToolWithIntegration(
  integration: ToolIntegration,
  spec: ToolLaunchSpec,
  publishResumeCursor?: NonNullable<
    Parameters<typeof createToolLaunchContext>[0]["publishResumeCursor"]
  >
): Promise<ToolLaunchResult> {
  const launch = createToolLaunchContext({
    spec,
    log: (line) => process.stderr.write(`${line}\n`),
    prepareForPassthrough: () => {},
    registerPort: (_name, port) => `http://127.0.0.1:${port}`,
    unregisterPort: () => {},
    ...(publishResumeCursor !== undefined ? { publishResumeCursor } : {})
  });
  try {
    return await integration.launch(launch.context);
  } finally {
    await launch.dispose();
  }
}

export async function launchTool(input: {
  tool: string;
  config?: RouterConfig;
  gatewayUrl: string;
  model?: string;
  effort?: string;
  args?: readonly string[];
  cwd?: string;
  authToken?: string;
  reasoning?: ReasoningSelection;
  session?: ToolSessionIntent;
  publishResumeCursor?: (
    cursor: Parameters<
      NonNullable<Parameters<typeof createToolLaunchContext>[0]["publishResumeCursor"]>
    >[0],
    spec: ToolLaunchSpec
  ) => void | Promise<void>;
}): Promise<ToolLaunchResult> {
  const integration = routekitToolRegistry.get(input.tool);
  if (integration === undefined) throw new Error(`unknown tool: ${input.tool}`);
  if (integration.binary !== undefined && !commandOnPath(integration.binary)) {
    throw new Error(
      `routekit preflight failed: "${integration.binary}" was not found on PATH — ` +
        (integration.installHint ?? `install ${integration.binary}`)
    );
  }
  const catalog = await fetchLiveCatalog(input.gatewayUrl, {
    ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
    ...(input.config?.defaultModel !== undefined
      ? { defaultModel: input.config.defaultModel }
      : input.model !== undefined
        ? { defaultModel: input.model }
        : {})
  });
  const config =
    input.config ??
    ({
      providers: {},
      ...(input.model !== undefined ? { defaultModel: input.model } : {})
    } as RouterConfig);
  const spec = buildToolLaunchSpec({
    config,
    catalog: catalog.models,
    gatewayUrl: input.gatewayUrl,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(input.args !== undefined ? { args: input.args } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    ...(input.session !== undefined ? { session: input.session } : {})
  });
  return await launchToolWithIntegration(
    integration,
    spec,
    input.publishResumeCursor === undefined
      ? undefined
      : (cursor) => input.publishResumeCursor?.(cursor, spec)
  );
}
