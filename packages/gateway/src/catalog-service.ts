import type {
  ModelReasoningCapabilities,
  RequestAttribution
} from "@velum-labs/routekit-contracts";
import { codexCompatibility, reasoningEffortDescriptors } from "@velum-labs/routekit-contracts";
import { Effect } from "effect";

import type { ClaudeModelSelection } from "./adapters/anthropic-models.js";
import {
  anthropicModelsResponse,
  resolveClaudeModelSelection
} from "./adapters/anthropic-models.js";
import type { Backend, BackendModelRoute } from "./providers/backend.js";
import { gatewayTry, gatewayTryPromise } from "./effect/gateway.js";
import { decodeModelCatalogPayload } from "./providers/protocol.js";

export function catalogModelRoutes(backend: Backend): BackendModelRoute[] {
  if (backend.ports.models.kind === "static-model") return [];
  return (backend.ports.models.list() ?? []).flatMap((model) => {
    const route = backend.ports.models.resolveRoute(model);
    return route === undefined ? [] : [route];
  });
}

export function resolveClaudeSelection(
  backend: Backend,
  requested: string | undefined
): ClaudeModelSelection {
  return resolveClaudeModelSelection(
    requested,
    backend.ports.models.list() ?? [],
    catalogModelRoutes(backend)
  );
}

export function initialAttribution(
  backend: Backend,
  requested: string | undefined,
  nativeProvider?: "claude-code" | "codex"
): Partial<RequestAttribution> {
  const route = backend.ports.models.resolveRoute(requested, nativeProvider);
  const effectiveModel = route?.publicId ?? requested ?? backend.defaultModel;
  if (effectiveModel === undefined) return {};
  const slash = effectiveModel.indexOf("/");
  const provider =
    route?.provider ?? (slash > 0 ? effectiveModel.slice(0, slash) : (nativeProvider ?? "unknown"));
  const nativeModel =
    route?.nativeId ?? (slash > 0 ? effectiveModel.slice(slash + 1) : effectiveModel);
  return {
    effective_model: effectiveModel,
    native_model: nativeModel,
    provider,
    billing_mode:
      provider === "codex" || provider === "claude-code" || provider === "cliproxy"
        ? "subscription"
        : "api_key"
  };
}

function codexModelInfo(
  id: string,
  priority: number,
  reasoning?: ModelReasoningCapabilities
): Record<string, unknown> {
  const levels = reasoningEffortDescriptors(reasoning).map((effort) => ({
    effort: effort.id,
    description: effort.label
  }));
  return {
    slug: id,
    prefer_websockets: false,
    display_name: id,
    description: "RouteKit live model",
    ...(reasoning?.defaultEffort !== undefined
      ? { default_reasoning_level: reasoning.defaultEffort }
      : {}),
    supported_reasoning_levels: levels,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    base_instructions: "You are a coding agent.",
    model_messages: {
      instructions_template: "You are a coding agent.",
      instructions_variables: null
    },
    supports_reasoning_summaries:
      reasoning?.status === "supported" &&
      (reasoning.wireShape === "openai-responses" ||
        reasoning.wireShape === "anthropic" ||
        reasoning.wireShape === "openrouter"),
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 272_000,
    max_context_window: 272_000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    use_responses_lite: false
  };
}

export function codexPickerModels(
  backend: Backend,
  configured: Array<{ id: string } & Record<string, unknown>>,
  native: readonly Record<string, unknown>[],
  includeUnroutedNative: boolean
): Record<string, unknown>[] {
  const nativeBySlug = new Map(
    native.flatMap((entry) =>
      typeof entry.slug === "string" ? [[entry.slug, entry] as const] : []
    )
  );
  const seen = new Set<string>();
  const eligible = configured.filter((entry) => {
    if (backend.ports.models.kind === "static-model") return true;
    const route = backend.ports.models.resolveRoute(entry.id);
    if (route === undefined) return true;
    const tools = backend.ports.models.capabilities(entry.id).tools;
    return (
      codexCompatibility({
        id: entry.id,
        ...(route?.provider !== undefined ? { provider: route.provider } : {}),
        ...(route?.metadata?.architecture !== undefined
          ? { architecture: route.metadata.architecture }
          : {}),
        ...(route?.metadata?.supportedParameters !== undefined
          ? { supportedParameters: route.metadata.supportedParameters }
          : {}),
        ...(tools === "supported" ||
        tools === "degraded" ||
        tools === "unsupported" ||
        tools === "unknown"
          ? { capabilities: { tools } }
          : {}),
        ...(route?.reasoning !== undefined ? { reasoning: route.reasoning } : {})
      }).status === "compatible"
    );
  });
  const models = eligible.map((entry, priority) => {
    const route = backend.ports.models.resolveRoute(entry.id);
    const slug = route?.provider === "codex" ? route.nativeId : entry.id;
    seen.add(slug);
    const upstream = nativeBySlug.get(slug);
    return upstream === undefined
      ? codexModelInfo(slug, priority, route?.reasoning)
      : { ...upstream, slug, priority };
  });
  if (!includeUnroutedNative) return models;
  for (const entry of native) {
    const slug = typeof entry.slug === "string" ? entry.slug : undefined;
    if (slug === undefined || seen.has(slug)) continue;
    seen.add(slug);
    models.push(entry);
  }
  return models;
}

export function mergeAnthropicCatalogs(
  configured: Response,
  native: Response
): Effect.Effect<Response, Error> {
  if (!native.ok) return Effect.succeed(configured);
  return Effect.gen(function* () {
    const configuredPayload = yield* gatewayTryPromise(() => configured.json());
    const nativePayload = yield* gatewayTryPromise(() => native.json());
    return yield* gatewayTry(() => {
      const configuredBody = decodeModelCatalogPayload(configuredPayload, "routekit-anthropic");
      const nativeBody = decodeModelCatalogPayload(nativePayload, "anthropic");
      const data = [...configuredBody.data];
      const seen = new Set(data.map((entry) => entry.id));
      for (const entry of nativeBody.data) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        data.push(entry);
      }
      return Response.json(
        {
          ...nativeBody,
          data,
          has_more: false,
          first_id: typeof data[0]?.id === "string" ? data[0].id : undefined,
          last_id: typeof data.at(-1)?.id === "string" ? data.at(-1)?.id : undefined
        },
        { headers: native.headers }
      );
    });
  });
}

export function configuredAnthropicCatalog(backend: Backend): Response {
  return anthropicModelsResponse(
    backend.defaultModel,
    backend.ports.models.list(),
    catalogModelRoutes(backend)
  );
}
