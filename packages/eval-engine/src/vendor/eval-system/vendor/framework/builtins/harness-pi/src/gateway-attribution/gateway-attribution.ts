import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  DEFAULT_EVAL_INFERENCE_ORIGIN,
  evalInferenceOrigin,
  evalOpenAiCompatibleUrl,
} from "../../../../../../host-env.ts";
import { homedir } from "node:os";
import { join } from "node:path";

import { Option, Schema } from "effect";
import { ROUTEKIT_EVAL_GATEWAY_ATTRIBUTION_HEADERS } from "../../../routekit-eval/src/gateway-auth.ts";
import { normalizeEnvValue } from "../../../routekit-eval/src/process.ts";

import type { PiMaxTokensCap } from "../model/model.ts";

import { isAnthropicPiModelSlug } from "../model/model.ts";

const EMPTY_LENGTH = 0;
const JSON_INDENT = 2;
const FILE_NOT_FOUND_CODE = "ENOENT";
const PI_MODELS_FILE = "models.json";
const PI_GATEWAY_PROVIDER = "gateway";
const PI_HEADERS_FIELD = "headers";
const PI_PROVIDERS_FIELD = "providers";
const PI_MODEL_OVERRIDES_FIELD = "modelOverrides";
const PI_MAX_TOKENS_FIELD = "maxTokens";
const PI_BASE_URL_FIELD = "baseUrl";
const PI_ROUTEKIT_EVAL_PROXY_MARKER_FIELD = "__routekitEvalCaptureProxy";
const PI_COMPAT_FIELD = "compat";
const PI_CACHE_CONTROL_FORMAT_FIELD = "cacheControlFormat";
const PI_ANTHROPIC_CACHE_CONTROL_FORMAT = "anthropic";
const PI_ROUTEKIT_EVAL_CACHE_CONTROL_MARKER_FIELD = "__routekitEvalCacheControlFormat";
const ROUTEKIT_EVAL_PI_AGENT_DIR = ".routekit-eval";
const ROUTEKIT_EVAL_PI_AGENT_SUBDIR = "pi-agent";

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

// Default to an isolated routekit-eval-managed directory so we never mutate the user's
// real `~/.pi/agent` config (auth still flows via the ROUTEKIT_EVAL_BEARER_TOKEN env).
const resolvePiAgentDir = (env: NodeJS.ProcessEnv): string =>
  normalizeEnvValue(env[PI_CODING_AGENT_DIR_ENV]) ??
  join(homedir(), ROUTEKIT_EVAL_PI_AGENT_DIR, ROUTEKIT_EVAL_PI_AGENT_SUBDIR);

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
  gateway: Record<string, unknown>,
  headers: readonly (readonly [string, string])[]
): boolean => {
  const existingHeaders = projectJsonObject(gateway[PI_HEADERS_FIELD]);
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
    gateway[PI_HEADERS_FIELD] = existingHeaders;
  }
  return changed;
};

// Writes the `maxTokens` cap LOWERING only (a smaller value, or none present):
// this makes the write idempotent, lets a reactive 402 retry ratchet the cap
// down further, and guarantees we never RAISE a model whose own budget is
// already smaller (which could itself trip the 402).
const mergeModelCap = (
  gateway: Record<string, unknown>,
  modelCap: PiMaxTokensCap
): boolean => {
  const overrides = projectJsonObject(gateway[PI_MODEL_OVERRIDES_FIELD]);
  const modelOverride = projectJsonObject(overrides[modelCap.modelId]);
  const existing = modelOverride[PI_MAX_TOKENS_FIELD];
  if (typeof existing === "number" && existing <= modelCap.maxTokens) {
    return false;
  }
  modelOverride[PI_MAX_TOKENS_FIELD] = modelCap.maxTokens;
  overrides[modelCap.modelId] = modelOverride;
  gateway[PI_MODEL_OVERRIDES_FIELD] = overrides;
  return true;
};

// Migration cleanup for users with an routekit-eval-written baseUrl and
// __routekitEvalCaptureProxy marker in shared models.json. The proxy no longer exists,
// but leaving this cleanup in place would permanently point pi at a dead port.
const PI_ROUTEKIT_EVAL_HOST_API_BASE_URL_FIELD = "__routekitEvalHostApiBaseUrl";

const mergeHostApiBaseUrl = (
  gateway: Record<string, unknown>
): boolean => {
  const wanted =
    evalInferenceOrigin() === DEFAULT_EVAL_INFERENCE_ORIGIN
      ? undefined
      : evalOpenAiCompatibleUrl();
  const owned = gateway[PI_ROUTEKIT_EVAL_HOST_API_BASE_URL_FIELD] === true;
  const existing = gateway[PI_BASE_URL_FIELD];
  if (wanted === undefined) {
    if (!owned) return false;
    gateway[PI_BASE_URL_FIELD] = undefined;
    gateway[PI_ROUTEKIT_EVAL_HOST_API_BASE_URL_FIELD] = undefined;
    return true;
  }
  if (typeof existing === "string" && !owned) return false;
  if (existing === wanted && owned) return false;
  gateway[PI_BASE_URL_FIELD] = wanted;
  gateway[PI_ROUTEKIT_EVAL_HOST_API_BASE_URL_FIELD] = true;
  return true;
};

const clearOwnedCaptureBaseUrl = (
  gateway: Record<string, unknown>
): boolean => {
  if (gateway[PI_ROUTEKIT_EVAL_PROXY_MARKER_FIELD] !== true) {
    return false;
  }
  gateway[PI_BASE_URL_FIELD] = undefined;
  gateway[PI_ROUTEKIT_EVAL_PROXY_MARKER_FIELD] = undefined;
  return true;
};

// pi 0.80.2 omits `compat.cacheControlFormat` on every `~anthropic/*` catalog
// entry, and its fallback prefix test (`model.id.startsWith("anthropic/")`) is
// defeated by the same `~`, so no cache_control breakpoint is ever emitted and
// each turn re-sends the whole prefix at full price. routekit-eval writes the field
// itself, marked as routekit-eval-owned so a later non-Anthropic run clears it rather
// than inheriting it from the persisted config. See ROUTEKIT_EVAL-950.
const mergeOwnedCacheControl = (
  gateway: Record<string, unknown>,
  anthropic: boolean
): boolean => {
  const compat = projectJsonObject(gateway[PI_COMPAT_FIELD]);
  const existing = compat[PI_CACHE_CONTROL_FORMAT_FIELD];
  // The marker alone is not ownership. A user who hand-edits the value away
  // from the one routekit-eval wrote has taken the field back, even with the marker still
  // sitting there, so routekit-eval must neither overwrite nor clear it.
  const owned =
    gateway[PI_ROUTEKIT_EVAL_CACHE_CONTROL_MARKER_FIELD] === true &&
    (existing === undefined || existing === PI_ANTHROPIC_CACHE_CONTROL_FORMAT);
  if (!owned && typeof existing === "string") {
    return false;
  }
  if (!anthropic) {
    if (!owned) {
      return false;
    }
    compat[PI_CACHE_CONTROL_FORMAT_FIELD] = undefined;
    gateway[PI_COMPAT_FIELD] = compat;
    gateway[PI_ROUTEKIT_EVAL_CACHE_CONTROL_MARKER_FIELD] = undefined;
    return true;
  }
  if (existing === PI_ANTHROPIC_CACHE_CONTROL_FORMAT && owned) {
    return false;
  }
  compat[PI_CACHE_CONTROL_FORMAT_FIELD] = PI_ANTHROPIC_CACHE_CONTROL_FORMAT;
  gateway[PI_COMPAT_FIELD] = compat;
  gateway[PI_ROUTEKIT_EVAL_CACHE_CONTROL_MARKER_FIELD] = true;
  return true;
};

/**
 * Merge routekit-eval's Gateway config into pi's `models.json`
 * (`providers.gateway`): the attribution `headers`, and — when `modelCap` is
 * given — a per-model `maxTokens` override so a request stays within the budget
 * the account can afford (ROUTEKIT_EVAL-351). The cap is model-agnostic: paid endpoints
 * hit the same 402 as free ones (ROUTEKIT_EVAL-882). Also writes an routekit-eval-owned
 * `compat.cacheControlFormat: "anthropic"` when `modelSlug` resolves to an
 * Anthropic model, clearing it on a later non-Anthropic run (ROUTEKIT_EVAL-950), and
 * clears a stale capture-proxy `baseUrl` an older routekit-eval persisted (ROUTEKIT_EVAL-963). Returns
 * the serialized file content when a write is needed, or `undefined` when
 * nothing changed or the existing content is present but not a decodable JSON
 * object (so a user's config is never clobbered). Values already present are
 * preserved, so user overrides win.
 */
interface MergePiModelsConfigInput {
  readonly existingContent: string | undefined;
  readonly headers: readonly (readonly [string, string])[];
  readonly modelCap?: PiMaxTokensCap | undefined;
  readonly modelSlug?: string | undefined;
}

const mergePiModelsConfigInternal = ({
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
  const gateway = projectJsonObject(providers[PI_GATEWAY_PROVIDER]);

  const headersChanged = mergeAttributionHeaders(gateway, headers);
  const capChanged =
    modelCap !== undefined && mergeModelCap(gateway, modelCap);
  const baseUrlChanged = clearOwnedCaptureBaseUrl(gateway);
  const hostBaseUrlChanged = mergeHostApiBaseUrl(gateway);
  const cacheControlChanged = mergeOwnedCacheControl(
    gateway,
    modelSlug !== undefined && isAnthropicPiModelSlug(modelSlug)
  );

  if (
    !(headersChanged || capChanged || baseUrlChanged || hostBaseUrlChanged || cacheControlChanged)
  ) {
    return undefined;
  }

  providers[PI_GATEWAY_PROVIDER] = gateway;
  config[PI_PROVIDERS_FIELD] = providers;
  return `${JSON.stringify(config, null, JSON_INDENT)}\n`;
};

export const mergePiModelsConfig = (
  input: MergePiModelsConfigInput
): string | undefined => mergePiModelsConfigInternal(input);

// pi has no header/max-tokens env vars, so routekit-eval's Gateway config is injected
// through its models.json (`providers.gateway`), which takes precedence over
// pi's built-in `pi.dev` defaults: the attribution headers, an optional
// per-model `maxTokens` cap for any endpoint, free or paid (ROUTEKIT_EVAL-351, ROUTEKIT_EVAL-882),
// and an routekit-eval-owned `compat.cacheControlFormat` for Anthropic slugs (ROUTEKIT_EVAL-950).
// Best-effort: never
// block a run on a config write failure.
interface EnsurePiGatewayAttributionInput {
  readonly env: NodeJS.ProcessEnv;
  readonly modelCap?: PiMaxTokensCap | undefined;
  readonly modelSlug?: string | undefined;
}

export const ensurePiGatewayAttribution = async ({
  env,
  modelCap,
  modelSlug,
}: EnsurePiGatewayAttributionInput): Promise<void> => {
  const dir = normalizeEnvValue(env[PI_CODING_AGENT_DIR_ENV]);
  if (dir === undefined) {
    return;
  }

  const modelsPath = join(dir, PI_MODELS_FILE);
  try {
    const existingContent = await readModelsFile(modelsPath);
    const merged = mergePiModelsConfig({
      existingContent,
      headers: ROUTEKIT_EVAL_GATEWAY_ATTRIBUTION_HEADERS,
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
