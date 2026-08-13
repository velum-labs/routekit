export {
  API_PROVIDER_IDS,
  configuredProviderIds,
  DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS,
  DEFAULT_LEADERBOARD_LIVE_LIMIT,
  DEFAULT_LEADERBOARD_LIVE_TTL_HOURS,
  leaderboardConfigSchema,
  modelPolicySchema,
  parseRouterConfig,
  PROVIDER_IDS,
  providerPolicySchema,
  reasoningCapabilityOverrideSchema,
  resolveLeaderboardConfig,
  routerConfigSchema,
  splitNamespacedModel,
  SUBSCRIPTION_PROVIDER_IDS
} from "./router-config.js";
export type {
  ApiProviderId,
  LeaderboardConfig,
  ModelPolicy,
  ProviderId,
  ProviderPolicy,
  RouterConfig,
  SubscriptionProviderId
} from "./router-config.js";

export type ConfigSource = "flag" | "config" | "default";
export type LayeredValue<T> = { value: T; source: ConfigSource };

export function resolveLayer<T>(
  flag: T | undefined,
  config: T | undefined,
  fallback: T
): LayeredValue<T> {
  if (flag !== undefined) return { value: flag, source: "flag" };
  if (config !== undefined) return { value: config, source: "config" };
  return { value: fallback, source: "default" };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function editConfig<T, U = T>(
  current: T,
  mutate: (draft: T) => void,
  clone: (value: T) => T,
  validate: (draft: T) => U
): U {
  const draft = clone(current);
  mutate(draft);
  return validate(draft);
}
