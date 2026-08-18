import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  DEFAULT_EVAL_API_BASE_URL,
  evalApiBaseUrl,
  evalOpenAiCompatibleUrl,
} from "../../../../../../host-env.ts";
import { homedir } from "node:os";
import { join } from "node:path";

import { Option, Schema } from "effect";
import { ORI_OPENROUTER_ATTRIBUTION_HEADERS } from "../../../ori/src/openrouter-auth.ts";
import { normalizeEnvValue } from "../../../ori/src/process.ts";

import type { PiMaxTokensCap } from "../model/model.ts";

import { isAnthropicPiModelSlug } from "../model/model.ts";

const EMPTY_LENGTH = 0;
const JSON_INDENT = 2;
const FILE_NOT_FOUND_CODE = "ENOENT";
const PI_MODELS_FILE = "models.json";
const PI_OPENROUTER_PROVIDER = "openrouter";
const PI_HEADERS_FIELD = "headers";
const PI_PROVIDERS_FIELD = "providers";
const PI_MODEL_OVERRIDES_FIELD = "modelOverrides";
const PI_MODELS_FIELD = "models";
const PI_MAX_TOKENS_FIELD = "maxTokens";
const HOST_OPENROUTER_MODELS = [
  {
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
  },
  {
    id: "openai/gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
  },
  {
    id: "openai/gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
  },
] as const;
const PI_BASE_URL_FIELD = "baseUrl";
const PI_API_KEY_FIELD = "apiKey";
const PI_OPENROUTER_API_KEY_REF = "$OPENROUTER_API_KEY";
const PI_ORI_PROXY_MARKER_FIELD = "__oriCaptureProxy";
const PI_COMPAT_FIELD = "compat";
const PI_CACHE_CONTROL_FORMAT_FIELD = "cacheControlFormat";
const PI_ANTHROPIC_CACHE_CONTROL_FORMAT = "anthropic";
const PI_ORI_CACHE_CONTROL_MARKER_FIELD = "__oriCacheControlFormat";
const ORI_PI_AGENT_DIR = ".ori";
const ORI_PI_AGENT_SUBDIR = "pi-agent";

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
type JsonObject = typeof JsonObjectSchema.Type;

const decodeJsonObjectString = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonObjectSchema)
);
const decodeJsonObject = Schema.decodeUnknownOption(JsonObjectSchema);

/** A mutable copy of the decoded JSON object, or {} when undecodable. */
const projectJsonObject = (value: unknown): Record<string, unknown> => ({
  ...Option.getOrElse(decodeJsonObject(value), () => ({}) as JsonObject),
});

const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

// Default to an isolated ori-managed directory so we never mutate the user's
// real `~/.pi/agent` config (auth still flows via the OPENROUTER_API_KEY env).
const resolvePiAgentDir = (env: NodeJS.ProcessEnv): string =>
  normalizeEnvValue(env[PI_CODING_AGENT_DIR_ENV]) ??
  join(homedir(), ORI_PI_AGENT_DIR, ORI_PI_AGENT_SUBDIR);

const isFileNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === FILE_NOT_FOUND_CODE;

const readModelsFile = async (
  modelsPath: string
): Promise<string | undefined> => {
  try {
    return await readFile(modelsPath, "utf-8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }
};

// Headers already present (case-insensitive) are preserved so user overrides
// win.
const mergeAttributionHeaders = (
  openrouter: Record<string, unknown>,
  headers: readonly (readonly [string, string])[]
): boolean => {
  const existingHeaders = projectJsonObject(openrouter[PI_HEADERS_FIELD]);
  const presentNames = new Set(
    Object.keys(existingHeaders).map((name) => name.toLowerCase())
  );
  let changed = false;
  for (const [name, value] of headers) {
    if (!presentNames.has(name.toLowerCase())) {
      existingHeaders[name] = value;
      changed = true;
    }
  }
  if (changed) {
    openrouter[PI_HEADERS_FIELD] = existingHeaders;
  }
  return changed;
};

// Writes the `maxTokens` cap LOWERING only (a smaller value, or none present):
// this makes the write idempotent, lets a reactive 402 retry ratchet the cap
// down further, and guarantees we never RAISE a model whose own budget is
// already smaller (which could itself trip the 402).
const mergeModelCap = (
  openrouter: Record<string, unknown>,
  modelCap: PiMaxTokensCap
): boolean => {
  const overrides = projectJsonObject(openrouter[PI_MODEL_OVERRIDES_FIELD]);
  const modelOverride = projectJsonObject(overrides[modelCap.modelId]);
  const existing = modelOverride[PI_MAX_TOKENS_FIELD];
  if (typeof existing === "number" && existing <= modelCap.maxTokens) {
    return false;
  }
  modelOverride[PI_MAX_TOKENS_FIELD] = modelCap.maxTokens;
  overrides[modelCap.modelId] = modelOverride;
  openrouter[PI_MODEL_OVERRIDES_FIELD] = overrides;
  return true;
};

// Migration cleanup for users with an ori-written baseUrl and
// __oriCaptureProxy marker in shared models.json. The proxy no longer exists,
// but leaving this cleanup in place would permanently point pi at a dead port.
const PI_ORI_HOST_API_BASE_URL_FIELD = "__oriHostApiBaseUrl";

const mergeHostApiBaseUrl = (
  openrouter: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
): boolean => {
  const wanted =
    evalApiBaseUrl(env) === DEFAULT_EVAL_API_BASE_URL
      ? undefined
      : evalOpenAiCompatibleUrl(env);
  const owned = openrouter[PI_ORI_HOST_API_BASE_URL_FIELD] === true;
  const existing = openrouter[PI_BASE_URL_FIELD];
  // A Claude-spawned `ori eval` often lacks ORI_EVAL_API_BASE_URL. Clearing an
  // owned bridge URL there sends Pi at OpenRouter with the child token.
  if (wanted === undefined) return false;
  if (typeof existing === "string" && !owned) return false;
  if (existing === wanted && owned) return false;
  openrouter[PI_BASE_URL_FIELD] = wanted;
  openrouter[PI_ORI_HOST_API_BASE_URL_FIELD] = true;
  return true;
};

const mergeHostCompat = (openrouter: Record<string, unknown>): boolean => {
  const compat = projectJsonObject(openrouter[PI_COMPAT_FIELD]);
  if (compat.supportsReasoningEffort === false) return false;
  compat.supportsReasoningEffort = false;
  openrouter[PI_COMPAT_FIELD] = compat;
  return true;
};

const mergeOpenRouterApiKeyRef = (
  openrouter: Record<string, unknown>,
): boolean => {
  if (typeof openrouter[PI_API_KEY_FIELD] === "string") return false;
  openrouter[PI_API_KEY_FIELD] = PI_OPENROUTER_API_KEY_REF;
  return true;
};

const mergeHostOpenRouterModels = (
  openrouter: Record<string, unknown>,
): boolean => {
  const existing = Array.isArray(openrouter[PI_MODELS_FIELD])
    ? [...(openrouter[PI_MODELS_FIELD] as unknown[])]
    : [];
  const byId = new Map<string, unknown>();
  for (const entry of existing) {
    const id =
      typeof entry === "object" && entry !== null && "id" in entry
        ? String((entry as { id: unknown }).id)
        : "";
    if (id !== "") byId.set(id, entry);
  }
  let changed = false;
  for (const model of HOST_OPENROUTER_MODELS) {
    if (byId.has(model.id)) continue;
    byId.set(model.id, { ...model });
    changed = true;
  }
  if (!changed) return false;
  openrouter[PI_MODELS_FIELD] = [...byId.values()];
  return true;
};

const clearOwnedCaptureBaseUrl = (
  openrouter: Record<string, unknown>
): boolean => {
  if (openrouter[PI_ORI_PROXY_MARKER_FIELD] !== true) {
    return false;
  }
  openrouter[PI_BASE_URL_FIELD] = undefined;
  openrouter[PI_ORI_PROXY_MARKER_FIELD] = undefined;
  return true;
};

// pi 0.80.2 omits `compat.cacheControlFormat` on every `~anthropic/*` catalog
// entry, and its fallback prefix test (`model.id.startsWith("anthropic/")`) is
// defeated by the same `~`, so no cache_control breakpoint is ever emitted and
// each turn re-sends the whole prefix at full price. ori writes the field
// itself, marked as ori-owned so a later non-Anthropic run clears it rather
// than inheriting it from the persisted config. See ORI-950.
const mergeOwnedCacheControl = (
  openrouter: Record<string, unknown>,
  anthropic: boolean
): boolean => {
  const compat = projectJsonObject(openrouter[PI_COMPAT_FIELD]);
  const existing = compat[PI_CACHE_CONTROL_FORMAT_FIELD];
  // The marker alone is not ownership. A user who hand-edits the value away
  // from the one ori wrote has taken the field back, even with the marker still
  // sitting there, so ori must neither overwrite nor clear it.
  const owned =
    openrouter[PI_ORI_CACHE_CONTROL_MARKER_FIELD] === true &&
    (existing === undefined || existing === PI_ANTHROPIC_CACHE_CONTROL_FORMAT);
  if (!owned && typeof existing === "string") {
    return false;
  }
  if (!anthropic) {
    if (!owned) {
      return false;
    }
    compat[PI_CACHE_CONTROL_FORMAT_FIELD] = undefined;
    openrouter[PI_COMPAT_FIELD] = compat;
    openrouter[PI_ORI_CACHE_CONTROL_MARKER_FIELD] = undefined;
    return true;
  }
  if (existing === PI_ANTHROPIC_CACHE_CONTROL_FORMAT && owned) {
    return false;
  }
  compat[PI_CACHE_CONTROL_FORMAT_FIELD] = PI_ANTHROPIC_CACHE_CONTROL_FORMAT;
  openrouter[PI_COMPAT_FIELD] = compat;
  openrouter[PI_ORI_CACHE_CONTROL_MARKER_FIELD] = true;
  return true;
};

/**
 * Merge ori's OpenRouter config into pi's `models.json`
 * (`providers.openrouter`): the attribution `headers`, and — when `modelCap` is
 * given — a per-model `maxTokens` override so a request stays within the budget
 * the account can afford (ORI-351). The cap is model-agnostic: paid endpoints
 * hit the same 402 as free ones (ORI-882). Also writes an ori-owned
 * `compat.cacheControlFormat: "anthropic"` when `modelSlug` resolves to an
 * Anthropic model, clearing it on a later non-Anthropic run (ORI-950), and
 * clears a stale capture-proxy `baseUrl` an older ori persisted (ORI-963). Returns
 * the serialized file content when a write is needed, or `undefined` when
 * nothing changed or the existing content is present but not a decodable JSON
 * object (so a user's config is never clobbered). Values already present are
 * preserved, so user overrides win.
 */
interface MergePiModelsConfigInput {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly existingContent: string | undefined;
  readonly headers: readonly (readonly [string, string])[];
  readonly modelCap?: PiMaxTokensCap | undefined;
  readonly modelSlug?: string | undefined;
}

const mergePiModelsConfigInternal = ({
  env,
  existingContent,
  headers,
  modelCap,
  modelSlug,
}: MergePiModelsConfigInput): string | undefined => {
  const normalized = existingContent?.trim();
  const decoded =
    normalized === undefined || normalized.length === EMPTY_LENGTH
      ? Option.some<JsonObject>({})
      : decodeJsonObjectString(normalized);
  if (Option.isNone(decoded)) {
    return undefined;
  }

  const config: Record<string, unknown> = { ...decoded.value };
  const providers = projectJsonObject(config[PI_PROVIDERS_FIELD]);
  const openrouter = projectJsonObject(providers[PI_OPENROUTER_PROVIDER]);

  const headersChanged = mergeAttributionHeaders(openrouter, headers);
  const capChanged =
    modelCap !== undefined && mergeModelCap(openrouter, modelCap);
  const baseUrlChanged = clearOwnedCaptureBaseUrl(openrouter);
  const hostBaseUrlChanged = mergeHostApiBaseUrl(openrouter, env);
  const apiKeyChanged = mergeOpenRouterApiKeyRef(openrouter);
  const modelsChanged = mergeHostOpenRouterModels(openrouter);
  const compatChanged = mergeHostCompat(openrouter);
  const cacheControlChanged = mergeOwnedCacheControl(
    openrouter,
    modelSlug !== undefined && isAnthropicPiModelSlug(modelSlug)
  );

  if (
    !(
      headersChanged ||
      capChanged ||
      baseUrlChanged ||
      hostBaseUrlChanged ||
      apiKeyChanged ||
      modelsChanged ||
      compatChanged ||
      cacheControlChanged
    )
  ) {
    return undefined;
  }

  providers[PI_OPENROUTER_PROVIDER] = openrouter;
  config[PI_PROVIDERS_FIELD] = providers;
  return `${JSON.stringify(config, null, JSON_INDENT)}\n`;
};

export const mergePiModelsConfig = (
  input: MergePiModelsConfigInput
): string | undefined => mergePiModelsConfigInternal(input);

// pi has no header/max-tokens env vars, so ori's OpenRouter config is injected
// through its models.json (`providers.openrouter`), which takes precedence over
// pi's built-in `pi.dev` defaults: the attribution headers, an optional
// per-model `maxTokens` cap for any endpoint, free or paid (ORI-351, ORI-882),
// and an ori-owned `compat.cacheControlFormat` for Anthropic slugs (ORI-950).
// Best-effort: never
// block a run on a config write failure.
interface EnsurePiOpenRouterAttributionInput {
  readonly env: NodeJS.ProcessEnv;
  readonly modelCap?: PiMaxTokensCap | undefined;
  readonly modelSlug?: string | undefined;
}

export const ensurePiOpenRouterAttribution = async ({
  env,
  modelCap,
  modelSlug,
}: EnsurePiOpenRouterAttributionInput): Promise<void> => {
  const dir = normalizeEnvValue(env[PI_CODING_AGENT_DIR_ENV]);
  if (dir === undefined) {
    return;
  }

  const modelsPath = join(dir, PI_MODELS_FILE);
  try {
    const existingContent = await readModelsFile(modelsPath);
    const merged = mergePiModelsConfig({
      env,
      existingContent,
      headers: ORI_OPENROUTER_ATTRIBUTION_HEADERS,
      modelCap,
      modelSlug,
    });
    if (merged !== undefined) {
      await mkdir(dir, { recursive: true });
      await writeFile(modelsPath, merged, "utf-8");
    }
  } catch {
    // Config write is non-critical; leave any existing config untouched on failure.
  }
};

export {
  decodeJsonObject,
  decodeJsonObjectString,
  PI_CODING_AGENT_DIR_ENV,
  projectJsonObject,
  resolvePiAgentDir,
};
export type { JsonObject };
