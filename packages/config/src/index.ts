import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isRecord, parseRouterConfig, type RouterConfig } from "@velum-labs/routekit-config-core";
import { writeFileAtomic } from "@velum-labs/routekit-runtime";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type LoadedRouterConfig = {
  config: RouterConfig;
  path: string;
};

export type {
  ApiProviderId,
  CompositionalRoutingConfig,
  LeaderboardConfig,
  ModelPolicy,
  ProviderId,
  ProviderPolicy,
  RouterConfig,
  RoutingObjectivePolicyConfig,
  SubscriptionProviderId
} from "@velum-labs/routekit-config-core";
export {
  API_PROVIDER_IDS,
  compositionalRoutingConfigSchema,
  configuredProviderIds,
  DEFAULT_CLASSIFIER_MODEL,
  DEFAULT_COMPOSITIONAL_ROUTING_UNKNOWN_WEIGHT,
  DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS,
  DEFAULT_LEADERBOARD_LIVE_LIMIT,
  DEFAULT_LEADERBOARD_LIVE_TTL_HOURS,
  leaderboardConfigSchema,
  modelPolicySchema,
  PROVIDER_IDS,
  parseRouterConfig,
  providerPolicySchema,
  reasoningCapabilityOverrideSchema,
  resolveCompositionalRoutingConfig,
  resolveLeaderboardConfig,
  routingObjectivePolicySchema,
  routerConfigSchema,
  SUBSCRIPTION_PROVIDER_IDS,
  splitNamespacedModel
} from "@velum-labs/routekit-config-core";

/** Required namespaced model ids absent from a live catalog. */
export function missingModelIds(
  required: Iterable<string>,
  availableModels: Iterable<string>
): string[] {
  const available = new Set(availableModels);
  return [...new Set(required)].filter((model) => !available.has(model));
}

/** Reject when any required namespaced model id is absent from a live catalog. */
export function assertModelsAvailable(
  required: Iterable<string>,
  availableModels: Iterable<string>,
  message = "missing models"
): void {
  const missing = missingModelIds(required, availableModels);
  if (missing.length > 0) throw new Error(`${message}: ${missing.join(", ")}`);
}

/** Resolve an explicit model, or the configured default/first live model. */
export function resolveModelId(
  config: RouterConfig,
  availableModels: Iterable<string>,
  requested?: string
): string {
  const available = [...new Set(availableModels)];
  if (requested !== undefined) {
    if (!available.includes(requested)) {
      throw new Error(`unknown model "${requested}" (available: ${available.join(", ")})`);
    }
    return requested;
  }
  const selected = config.defaultModel ?? available[0];
  if (selected === undefined) throw new Error("router catalog has no models");
  assertModelsAvailable([selected], available, "router config default model is not available");
  return selected;
}

export function routekitHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ROUTEKIT_HOME;
  return override !== undefined && override.length > 0
    ? resolve(override)
    : join(homedir(), ".routekit");
}

export function globalRouterConfigPath(home: string = homedir()): string {
  return join(home, ".config", "routekit", "router.yaml");
}

function assertNoInlineCredentials(value: unknown, source: string, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoInlineCredentials(entry, source, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const lowered = key.toLowerCase().replaceAll("-", "").replaceAll("_", "");
    if (
      lowered === "apikey" ||
      lowered === "token" ||
      lowered === "authorization" ||
      lowered === "xapikey" ||
      lowered === "xgoogapikey" ||
      lowered === "accesstoken" ||
      lowered === "refreshtoken" ||
      lowered === "clientsecret"
    ) {
      throw new Error(
        `${source}: inline credential field "${path.length > 0 ? `${path}.` : ""}${key}" is not allowed; use the provider registry's environment variable`
      );
    }
    assertNoInlineCredentials(child, source, path.length > 0 ? `${path}.${key}` : key);
  }
}

function assertCanonicalProviderKeys(value: unknown, source: string): void {
  if (!isRecord(value) || !isRecord(value.providers)) return;
  for (const retired of ["claude", "claudeCode"]) {
    if (Object.hasOwn(value.providers, retired)) {
      throw new Error(
        `${source}: provider "${retired}" is not supported; use the canonical "claude-code" key`
      );
    }
  }
}

function readYamlObject(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path}: invalid YAML (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (!isRecord(parsed)) throw new Error(`${path}: router config must be a YAML object`);
  assertCanonicalProviderKeys(parsed, path);
  assertNoInlineCredentials(parsed, path);
  return parsed;
}

/** Parse and validate an in-memory router YAML document without writing it. */
export function parseRouterConfigDocument(
  document: string,
  source = "router config"
): RouterConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(document);
  } catch (error) {
    throw new Error(
      `${source}: invalid YAML (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (!isRecord(parsed)) throw new Error(`${source}: router config must be a YAML object`);
  assertCanonicalProviderKeys(parsed, source);
  assertNoInlineCredentials(parsed, source);
  return parseRouterConfig(parsed);
}

export function loadRouterConfig(
  input: { home?: string; configPath?: string } = {}
): LoadedRouterConfig {
  const path =
    input.configPath !== undefined && input.configPath.length > 0
      ? resolve(input.configPath)
      : globalRouterConfigPath(input.home);
  if (!existsSync(path)) {
    throw new Error(`router config not found: ${path}; run \`routekit config init\``);
  }
  return {
    config: parseRouterConfig(readYamlObject(path)),
    path
  };
}

export function writeRouterConfig(path: string, config: RouterConfig | unknown): string {
  assertCanonicalProviderKeys(config, path);
  assertNoInlineCredentials(config, path);
  parseRouterConfig(config);
  return writeRouterConfigDocument(path, config);
}

function writeRouterConfigDocument(path: string, config: unknown): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, stringifyYaml(config), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function updateRouterConfig(
  path: string,
  mutate: (draft: Record<string, unknown>) => void
): RouterConfig {
  const current = existsSync(path) ? readYamlObject(path) : {};
  const draft = structuredClone(current);
  mutate(draft);
  const validated = parseRouterConfig(draft);
  writeRouterConfig(path, draft);
  return validated;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = parseRouterConfig({
  providers: {
    openai: {}
  },
  defaultModel: "openai/gpt-5.5"
});
