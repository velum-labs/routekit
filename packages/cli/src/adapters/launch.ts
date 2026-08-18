import { type RouterConfig, resolveModelId } from "@velum-labs/routekit-config";
import {
  type CodexBillingScope,
  type CodexModelCandidate,
  type ReasoningSelection,
  reasoningSelectionFromEffort
} from "@velum-labs/routekit-contracts";
import { resolveCodexStartupModel } from "@velum-labs/routekit-gateway";
import { commandOnPath } from "@velum-labs/routekit-runtime";
import { RouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { toolRegistry as routekitToolRegistry } from "@velum-labs/routekit-tool-registry";
import type {
  ToolIntegration,
  ToolLaunchSpec,
  ToolModel,
  ToolModelFeatureStatus
} from "@velum-labs/routekit-tools";
import { createToolLaunchContext } from "@velum-labs/routekit-tools";
import { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";

import { fetchLiveCatalog, type LiveModel } from "../catalog.js";
import { cliTry, cliTryPromise } from "../cli-session.js";

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
      ...(model.createdAt !== undefined ? { createdAt: model.createdAt } : {}),
      ...(model.providerPriority !== undefined ? { providerPriority: model.providerPriority } : {}),
      ...(model.provider !== undefined ? { provider: model.provider } : {}),
      features: {
        streaming: featureStatus(model.capabilities.streaming),
        tools: featureStatus(model.capabilities.tools),
        images: featureStatus(model.capabilities.images),
        reasoning_controls: featureStatus(model.capabilities.reasoning_controls)
      },
      ...(model.architecture !== undefined ? { architecture: model.architecture } : {}),
      ...(model.supportedParameters !== undefined
        ? { supportedParameters: model.supportedParameters }
        : {}),
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
  modelSelection?: "explicit" | "implicit";
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
    ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
    models,
    args: input.args ?? [],
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.authToken !== undefined ? { auth: { token: input.authToken } } : {})
  };
}

function billingScope(provider: string | undefined): CodexBillingScope | undefined {
  switch (provider) {
    case "codex":
    case "claude-code":
      return "subscription";
    case "openai":
    case "openrouter":
    case "bedrock":
      return "metered-api";
    default:
      return undefined;
  }
}

function codexCandidates(models: readonly LiveModel[]): CodexModelCandidate[] {
  return models.map((model) => {
    const scope = billingScope(model.provider);
    return {
      id: model.id,
      ...(model.id.includes("/") ? { nativeId: model.id.slice(model.id.indexOf("/") + 1) } : {}),
      ...(model.provider !== undefined ? { provider: model.provider } : {}),
      ...(scope !== undefined ? { billingScope: scope } : {}),
      ...(model.createdAt !== undefined ? { createdAt: model.createdAt } : {}),
      ...(model.providerPriority !== undefined ? { providerPriority: model.providerPriority } : {}),
      ...(model.architecture !== undefined ? { architecture: model.architecture } : {}),
      ...(model.supportedParameters !== undefined
        ? { supportedParameters: model.supportedParameters }
        : {}),
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {})
    };
  });
}

function withPreparedCodexMetadata(
  models: readonly LiveModel[],
  prepared: readonly CodexModelCandidate[]
): LiveModel[] {
  const byId = new Map(prepared.map((model) => [model.id, model]));
  return models.map((model) => {
    const candidate = byId.get(model.id);
    if (candidate === undefined) return model;
    return {
      ...model,
      ...(candidate.createdAt !== undefined ? { createdAt: candidate.createdAt } : {}),
      ...(candidate.providerPriority !== undefined
        ? { providerPriority: candidate.providerPriority }
        : {}),
      ...(candidate.architecture !== undefined ? { architecture: candidate.architecture } : {}),
      ...(candidate.supportedParameters !== undefined
        ? { supportedParameters: candidate.supportedParameters }
        : {})
    };
  });
}

export function resolveCodexLaunchSelection(input: {
  models: readonly LiveModel[];
  preferredModel: string;
  model?: string;
  modelSelection?: "explicit" | "implicit";
  prepared?: {
    compatibleModelIds: readonly string[];
    models: readonly CodexModelCandidate[];
  };
}): Effect.Effect<
  {
    model: string;
    modelSelection: "explicit" | "implicit";
    models: readonly LiveModel[];
  },
  Error,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    if (input.prepared !== undefined) {
      if (input.model === undefined) {
        return yield* new RouteKitFailure({
          message: "local Codex preparation did not select a startup model"
        });
      }
      return {
        model: input.model,
        modelSelection: input.modelSelection ?? "implicit",
        models: withPreparedCodexMetadata(input.models, input.prepared.models)
      };
    }
    const explicit = input.modelSelection === "explicit" || input.model !== undefined;
    const selected = yield* resolveCodexStartupModel({
      models: codexCandidates(input.models),
      preferredModel: input.preferredModel,
      ...(explicit && input.model !== undefined ? { requestedModel: input.model } : {})
    });
    return {
      model: selected.model,
      modelSelection: explicit ? "explicit" : "implicit",
      models: withPreparedCodexMetadata(input.models, selected.models)
    };
  });
}

export async function launchToolWithIntegration(
  integration: ToolIntegration,
  spec: ToolLaunchSpec
): Promise<number> {
  const launch = createToolLaunchContext({
    spec,
    log: (line) => process.stderr.write(`${line}\n`),
    prepareForPassthrough: () => {},
    registerPort: (_name, port) => `http://127.0.0.1:${port}`,
    unregisterPort: () => {}
  });
  try {
    return await integration.launch(launch.context);
  } finally {
    await launch.dispose();
  }
}

export function launchTool(input: {
  tool: string;
  config?: RouterConfig;
  gatewayUrl: string;
  model?: string;
  effort?: string;
  args?: readonly string[];
  cwd?: string;
  authToken?: string;
  reasoning?: ReasoningSelection;
  modelSelection?: "explicit" | "implicit";
  preparedCodexSelection?: {
    compatibleModelIds: readonly string[];
    models: readonly CodexModelCandidate[];
  };
}): Effect.Effect<number, Error, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const integration = yield* cliTry(() => {
      const found = routekitToolRegistry.get(input.tool);
      if (found === undefined) throw new Error(`unknown tool: ${input.tool}`);
      if (found.binary !== undefined && !commandOnPath(found.binary)) {
        throw new Error(
          `routekit preflight failed: "${found.binary}" was not found on PATH — ` +
            (found.installHint ?? `install ${found.binary}`)
        );
      }
      return found;
    });
    const catalog = yield* fetchLiveCatalog(input.gatewayUrl, {
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
    let selectedModel = input.model;
    let modelSelection = input.modelSelection;
    let catalogModels = catalog.models;
    if (input.tool === "codex") {
      const selected = yield* resolveCodexLaunchSelection({
        models: catalogModels,
        preferredModel: catalog.defaultModel,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(modelSelection !== undefined ? { modelSelection } : {}),
        ...(input.preparedCodexSelection !== undefined
          ? { prepared: input.preparedCodexSelection }
          : {})
      });
      selectedModel = selected.model;
      modelSelection = selected.modelSelection;
      catalogModels = selected.models;
    }
    const spec = yield* cliTry(() =>
      buildToolLaunchSpec({
        config,
        catalog: catalogModels,
        gatewayUrl: input.gatewayUrl,
        ...(selectedModel !== undefined ? { model: selectedModel } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
        ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
        ...(modelSelection !== undefined ? { modelSelection } : {})
      })
    );
    return yield* cliTryPromise(() => launchToolWithIntegration(integration, spec));
  });
}
