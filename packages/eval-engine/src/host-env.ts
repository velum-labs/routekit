import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const EVAL_API_BASE_URL_ENV = "ORI_EVAL_API_BASE_URL";
const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
const ANTHROPIC_BASE_URL_ENV = "ANTHROPIC_BASE_URL";
const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const DEFAULT_EVAL_API_BASE_URL = "https://openrouter.ai/api";

type HostEnvMap = Readonly<Record<string, string | undefined>>;
const hostEnvironment = new AsyncLocalStorage<HostEnvMap>();

const activeHostEnvironment = (env?: HostEnvMap): HostEnvMap =>
  env ?? hostEnvironment.getStore() ?? process.env;

const trimEnv = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const stripTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
};

/**
 * OpenAI-compatible API origin used for catalog, endpoints, and Claude's
 * Anthropic-compatible base. Default is OpenRouter. A host (later RouteKit)
 * overrides this with `ORI_EVAL_API_BASE_URL`.
 */
const evalApiBaseUrl = (env?: HostEnvMap): string => {
  const selected = activeHostEnvironment(env);
  return stripTrailingSlashes(
    trimEnv(selected[EVAL_API_BASE_URL_ENV]) ?? DEFAULT_EVAL_API_BASE_URL,
  );
};

const evalModelsCatalogUrl = (env?: HostEnvMap): string =>
  `${evalApiBaseUrl(env)}/v1/models?sort=top-weekly`;

const evalModelEndpointsUrlBase = (env?: HostEnvMap): string =>
  `${evalApiBaseUrl(env)}/v1/models`;

/** Pi's OpenAI-compatible provider `baseUrl` (`{origin}/v1`). */
const evalOpenAiCompatibleUrl = (env?: HostEnvMap): string =>
  `${evalApiBaseUrl(env)}/v1`;

const hostCredentialPresent = (env?: HostEnvMap): boolean =>
  trimEnv(activeHostEnvironment(env)[OPENROUTER_API_KEY_ENV]) !== undefined;

const withHostProviderEnvironment = <T>(
  env: HostEnvMap,
  task: () => Promise<T>,
): Promise<T> => hostEnvironment.run(env, task);

const PROCESS_ENV_OVERLAY_KEYS = [
  ANTHROPIC_BASE_URL_ENV,
  EVAL_API_BASE_URL_ENV,
  OPENROUTER_API_KEY_ENV,
  PI_CODING_AGENT_DIR_ENV,
  "HOME",
  "ORI_CLAUDE_BIN",
  "ORI_EVAL_TOOL_HOME",
] as const;

/**
 * Claude's adapter reads `process.env` when spawning the native binary, not the
 * isolated host map. Overlay the host provider keys for the turn, then restore.
 */
const withProcessEnvOverlay = async <T>(
  env: HostEnvMap,
  task: () => Promise<T>,
): Promise<T> => {
  const previous = new Map<string, string | undefined>();
  for (const name of PROCESS_ENV_OVERLAY_KEYS) {
    previous.set(name, process.env[name]);
    const value = trimEnv(env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await task();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

const applyIsolatedOriHome = (
  env: Record<string, string | undefined>,
): void => {
  const home = trimEnv(env.HOME);
  if (home === undefined) return;
  if (trimEnv(env[PI_CODING_AGENT_DIR_ENV]) === undefined) {
    env[PI_CODING_AGENT_DIR_ENV] = join(home, ".ori", "pi-agent");
  }
};

/**
 * Copy the host API origin onto `ANTHROPIC_BASE_URL` when the caller did not
 * set one. Claude's production harness already honors that env; this is the
 * product-level injection point so a later gateway can sit in front without
 * forking adapters.
 */
const applyHostProviderEnv = (env: Record<string, string | undefined> = process.env): void => {
  const base = evalApiBaseUrl(env);
  if (trimEnv(env[ANTHROPIC_BASE_URL_ENV]) === undefined && base !== DEFAULT_EVAL_API_BASE_URL) {
    env[ANTHROPIC_BASE_URL_ENV] = base;
  }
  applyIsolatedOriHome(env);
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
  PI_CODING_AGENT_DIR_ENV,
  trimEnv,
  withHostProviderEnvironment,
  withProcessEnvOverlay,
};
