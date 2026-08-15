const EVAL_INFERENCE_ORIGIN_ENV = "ROUTEKIT_EVAL_INFERENCE_ORIGIN";
const ROUTEKIT_EVAL_BEARER_TOKEN_ENV = "ROUTEKIT_EVAL_BEARER_TOKEN";
const ANTHROPIC_BASE_URL_ENV = "ANTHROPIC_BASE_URL";
const DEFAULT_EVAL_INFERENCE_ORIGIN = "http://127.0.0.1:8080";

type HostEnvMap = Readonly<Record<string, string | undefined>>;

const trimEnv = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/u, "");

/**
 * OpenAI-compatible API origin used for catalog, endpoints, and Claude's
 * Anthropic-compatible base. Default is Gateway. A host (later RouteKit)
 * overrides this with `ROUTEKIT_EVAL_INFERENCE_ORIGIN`.
 */
const evalInferenceOrigin = (env: HostEnvMap = process.env): string =>
  stripTrailingSlashes(trimEnv(env[EVAL_INFERENCE_ORIGIN_ENV]) ?? DEFAULT_EVAL_INFERENCE_ORIGIN);

const evalModelsCatalogUrl = (env: HostEnvMap = process.env): string =>
  `${evalInferenceOrigin(env)}/v1/models?sort=top-weekly`;

const evalModelEndpointsUrlBase = (env: HostEnvMap = process.env): string =>
  `${evalInferenceOrigin(env)}/v1/models`;

/** Pi's OpenAI-compatible provider `baseUrl` (`{origin}/v1`). */
const evalOpenAiCompatibleUrl = (env: HostEnvMap = process.env): string =>
  `${evalInferenceOrigin(env)}/v1`;

const hostCredentialPresent = (env: HostEnvMap = process.env): boolean =>
  trimEnv(env[ROUTEKIT_EVAL_BEARER_TOKEN_ENV]) !== undefined;

/**
 * Copy the host API origin onto `ANTHROPIC_BASE_URL` when the caller did not
 * set one. Claude's production harness already honors that env; this is the
 * product-level injection point so a later gateway can sit in front without
 * forking adapters.
 */
const applyHostProviderEnv = (env: Record<string, string | undefined> = process.env): void => {
  const base = evalInferenceOrigin(env);
  if (trimEnv(env[ANTHROPIC_BASE_URL_ENV]) !== undefined) return;
  if (base === DEFAULT_EVAL_INFERENCE_ORIGIN) return;
  env[ANTHROPIC_BASE_URL_ENV] = base;
};

export {
  ANTHROPIC_BASE_URL_ENV,
  applyHostProviderEnv,
  DEFAULT_EVAL_INFERENCE_ORIGIN,
  EVAL_INFERENCE_ORIGIN_ENV,
  evalInferenceOrigin,
  evalModelEndpointsUrlBase,
  evalModelsCatalogUrl,
  evalOpenAiCompatibleUrl,
  hostCredentialPresent,
  ROUTEKIT_EVAL_BEARER_TOKEN_ENV,
};
