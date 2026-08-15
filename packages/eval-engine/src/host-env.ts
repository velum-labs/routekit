const EVAL_API_BASE_URL_ENV = "ORI_EVAL_API_BASE_URL";
const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
const ANTHROPIC_BASE_URL_ENV = "ANTHROPIC_BASE_URL";
const DEFAULT_EVAL_API_BASE_URL = "https://openrouter.ai/api";

type HostEnvMap = Readonly<Record<string, string | undefined>>;

const trimEnv = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const stripTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
};

/**
 * OpenAI-compatible API origin used for catalog, endpoints, and Claude's
 * Anthropic-compatible base. Default is OpenRouter. A host (later RouteKit)
 * overrides this with `ORI_EVAL_API_BASE_URL`.
 */
const evalApiBaseUrl = (env: HostEnvMap = process.env): string =>
  stripTrailingSlashes(trimEnv(env[EVAL_API_BASE_URL_ENV]) ?? DEFAULT_EVAL_API_BASE_URL);

const evalModelsCatalogUrl = (env: HostEnvMap = process.env): string =>
  `${evalApiBaseUrl(env)}/v1/models?sort=top-weekly`;

const evalModelEndpointsUrlBase = (env: HostEnvMap = process.env): string =>
  `${evalApiBaseUrl(env)}/v1/models`;

/** Pi's OpenAI-compatible provider `baseUrl` (`{origin}/v1`). */
const evalOpenAiCompatibleUrl = (env: HostEnvMap = process.env): string =>
  `${evalApiBaseUrl(env)}/v1`;

const hostCredentialPresent = (env: HostEnvMap = process.env): boolean =>
  trimEnv(env[OPENROUTER_API_KEY_ENV]) !== undefined;

/**
 * Copy the host API origin onto `ANTHROPIC_BASE_URL` when the caller did not
 * set one. Claude's production harness already honors that env; this is the
 * product-level injection point so a later gateway can sit in front without
 * forking adapters.
 */
const applyHostProviderEnv = (env: Record<string, string | undefined> = process.env): void => {
  const base = evalApiBaseUrl(env);
  if (trimEnv(env[ANTHROPIC_BASE_URL_ENV]) !== undefined) return;
  if (base === DEFAULT_EVAL_API_BASE_URL) return;
  env[ANTHROPIC_BASE_URL_ENV] = base;
};

export {
  ANTHROPIC_BASE_URL_ENV,
  applyHostProviderEnv,
  DEFAULT_EVAL_API_BASE_URL,
  EVAL_API_BASE_URL_ENV,
  evalApiBaseUrl,
  evalModelEndpointsUrlBase,
  evalModelsCatalogUrl,
  evalOpenAiCompatibleUrl,
  hostCredentialPresent,
  OPENROUTER_API_KEY_ENV,
};
