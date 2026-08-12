/**
 * Claude Code model picker and Anthropic-shaped `/v1/models` discovery.
 * Catalog policy, not wire translation: picker ids resolve onto RouteKit
 * routes before the Messages codec runs.
 */

import type {
  ModelReasoningCapabilities,
  ReasoningSelection
} from "@velum-labs/routekit-contracts";
import type { AnthropicRequest } from "./anthropic-wire.js";

/** Historical Claude Code discovery alias prefix. Never emitted by new installs. */
export const CLAUDE_ALIAS_PREFIX = "claude-";

/**
 * Claude Code admits arbitrary custom entries in `availableModels` when they
 * begin with `anthropic.`. The RouteKit discriminator makes the value
 * reversible and reserves it from provider-native model spelling.
 */
export const CLAUDE_PICKER_PREFIX = "anthropic.routekit.";

export type ClaudePickerModelRoute = {
  publicId: string;
  nativeId: string;
  provider: string;
  reasoning?: ModelReasoningCapabilities;
};

export type ClaudeModelSelection =
  | {
      status: "resolved";
      model: string;
      clientModel: string;
      selection: ReasoningSelection;
    }
  | {
      status: "unsupported_effort";
      model: string;
      message: string;
    }
  | {
      status: "ambiguous_model";
      model: string;
      message: string;
    }
  | {
      status: "passthrough";
      model: string;
    };

/** Claude Code's new native-picker spelling for one RouteKit catalog route. */
export function claudePickerClientModel(route: ClaudePickerModelRoute): string {
  return `${CLAUDE_PICKER_PREFIX}${route.publicId}`;
}

export function resolveClaudeModelAlias(
  requested: string | undefined,
  modelIds: readonly string[] = [],
  modelRoutes: readonly ClaudePickerModelRoute[] = []
): string | undefined {
  if (requested === undefined) return undefined;
  const selection = resolveClaudeModelSelection(requested, modelIds, modelRoutes);
  return selection.status === "unsupported_effort" || selection.status === "ambiguous_model"
    ? undefined
    : selection.model;
}

function uniqueNativeModel(
  requested: string,
  modelRoutes: readonly ClaudePickerModelRoute[]
):
  | { status: "none" }
  | { status: "resolved"; model: string }
  | { status: "ambiguous"; models: readonly string[] } {
  const routes = new Map<string, ClaudePickerModelRoute>();
  for (const route of modelRoutes) {
    if (route.nativeId !== requested) continue;
    // Catalog aliases do not make an otherwise unique provider/native pair
    // ambiguous.
    const key = `${route.provider}\u0000${route.nativeId}`;
    if (!routes.has(key)) routes.set(key, route);
  }
  const values = [...routes.values()];
  if (values.length === 0) return { status: "none" };
  if (values.length === 1) return { status: "resolved", model: values[0]!.publicId };
  return {
    status: "ambiguous",
    models: values.map((route) => route.publicId).sort((left, right) => left.localeCompare(right))
  };
}

/**
 * Resolve a Claude Code picker id (base or effort-qualified) to the served
 * model and request-scoped reasoning selection.
 */
export function resolveClaudeModelSelection(
  requested: string | undefined,
  modelIds: readonly string[] = [],
  modelRoutes: readonly ClaudePickerModelRoute[] = []
): ClaudeModelSelection {
  if (requested === undefined) {
    return { status: "passthrough", model: "" };
  }
  if (modelIds.includes(requested)) {
    return {
      status: "resolved",
      model: requested,
      clientModel: requested,
      selection: { mode: "auto" }
    };
  }

  if (requested.startsWith(CLAUDE_PICKER_PREFIX)) {
    const candidate = requested.slice(CLAUDE_PICKER_PREFIX.length);
    if (modelIds.includes(candidate)) {
      return {
        status: "resolved",
        model: candidate,
        clientModel: requested,
        selection: { mode: "auto" }
      };
    }
  }

  const native = uniqueNativeModel(requested, modelRoutes);
  if (native.status === "resolved") {
    return {
      status: "resolved",
      model: native.model,
      clientModel: requested,
      selection: { mode: "auto" }
    };
  }
  if (native.status === "ambiguous") {
    return {
      status: "ambiguous_model",
      model: requested,
      message:
        `model "${requested}" is served by multiple RouteKit routes: ` +
        `${native.models.join(", ")}; select one of those canonical ids instead`
    };
  }

  return { status: "passthrough", model: requested };
}

/**
 * Apply a request-scoped effort selection onto an Anthropic Messages body.
 *
 * Effort selections use adaptive thinking plus `output_config.effort`. Base /
 * auto selections leave thinking and output_config untouched so provider
 * defaults remain in force.
 */
export function withClaudeReasoningSelection(
  body: AnthropicRequest,
  selection: ReasoningSelection
): AnthropicRequest {
  if (selection.mode !== "effort") return body;
  const outputConfig =
    body.output_config === null || body.output_config === undefined
      ? { effort: selection.effort }
      : { ...body.output_config, effort: selection.effort };
  return {
    ...body,
    thinking: { type: "adaptive" },
    output_config: outputConfig
  };
}

/**
 * Anthropic-shaped `/v1/models` response. IDs remain canonical RouteKit ids:
 * Claude Code filters arbitrary IDs from dynamic discovery, so RouteKit uses
 * its supported `availableModels` custom-model path for the native picker.
 * `modelIds` is the full advertised set (default model first); when absent we
 * fall back to the single backend default.
 */
export function anthropicModelsResponse(
  backendModel: string | undefined,
  modelIds?: readonly string[],
  _modelRoutes: readonly ClaudePickerModelRoute[] = []
): Response {
  const source =
    modelIds !== undefined && modelIds.length > 0
      ? modelIds
      : backendModel !== undefined
        ? [backendModel]
        : [];
  const seen = new Set<string>();
  const models: Array<{ type: "model"; id: string; display_name: string; created_at: string }> = [];
  for (const realId of source) {
    if (seen.has(realId)) continue;
    seen.add(realId);
    models.push({
      type: "model",
      id: realId,
      display_name: realId,
      created_at: new Date(0).toISOString()
    });
  }
  const ids = models.map((model) => model.id);
  return new Response(
    JSON.stringify({
      data: models,
      has_more: false,
      first_id: ids[0],
      last_id: ids[ids.length - 1]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
