import type { ModelReasoningCapabilities } from "@velum-labs/routekit-contracts";
import { z } from "zod";

export const API_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "bedrock",
  "google",
  "openrouter",
  "cliproxy"
] as const;

export const SUBSCRIPTION_PROVIDER_IDS = ["codex", "claude-code"] as const;
export const PROVIDER_IDS = [...API_PROVIDER_IDS, ...SUBSCRIPTION_PROVIDER_IDS] as const;

export type ApiProviderId = (typeof API_PROVIDER_IDS)[number];
export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDER_IDS)[number];
export type ProviderId = (typeof PROVIDER_IDS)[number];

const modelPolicyRuleSchema = z
  .string()
  .min(1)
  .superRefine((rule, context) => {
    const separator = rule.indexOf("/");
    const provider = separator < 0 ? "" : rule.slice(0, separator);
    const model = separator < 0 ? "" : rule.slice(separator + 1);
    if (
      !PROVIDER_IDS.includes(provider as ProviderId) ||
      model.length === 0 ||
      model.startsWith("/")
    ) {
      context.addIssue({
        code: "custom",
        message: `model policy rule "${rule}" must use a supported provider/model namespace`
      });
    }
  });

export const modelPolicySchema = z
  .object({
    allow: z.array(modelPolicyRuleSchema).optional(),
    deny: z.array(modelPolicyRuleSchema).optional()
  })
  .strict()
  .superRefine((policy, context) => {
    for (const field of ["allow", "deny"] as const) {
      const seen = new Set<string>();
      for (const [index, rule] of (policy[field] ?? []).entries()) {
        if (seen.has(rule)) {
          context.addIssue({
            code: "custom",
            path: [field, index],
            message: `duplicate model policy ${field} rule "${rule}"`
          });
        }
        seen.add(rule);
      }
    }
  });

export const providerPolicySchema = z
  .object({
    strategy: z.enum(["sticky", "round_robin", "capacity_weighted"]).default("capacity_weighted"),
    switchThreshold: z.number().min(0.01).max(1).default(0.9),
    probeIntervalMs: z.number().int().nonnegative().optional(),
    fallbackCooldownSeconds: z.number().nonnegative().optional()
  })
  .strict();

export const reasoningCapabilityOverrideSchema: z.ZodType<
  Omit<ModelReasoningCapabilities, "provenance">
> = z
  .object({
    status: z.enum(["supported", "unsupported", "unknown"]).default("supported"),
    efforts: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1).optional(),
            description: z.string().min(1).optional(),
            aliases: z.array(z.string().min(1)).optional()
          })
          .strict()
      )
      .optional(),
    defaultEffort: z.string().min(1).optional(),
    budget: z
      .object({
        minTokens: z.number().int().nonnegative().optional(),
        maxTokens: z.number().int().positive().optional(),
        defaultTokens: z.number().int().nonnegative().optional()
      })
      .strict()
      .optional(),
    adaptive: z.boolean().optional(),
    wireShape: z.string().min(1).optional()
  })
  .strict()
  .superRefine((capability, context) => {
    const ids = new Set<string>();
    for (const [index, effort] of (capability.efforts ?? []).entries()) {
      if (ids.has(effort.id)) {
        context.addIssue({
          code: "custom",
          path: ["efforts", index, "id"],
          message: `duplicate reasoning effort "${effort.id}"`
        });
      }
      ids.add(effort.id);
    }
    if (capability.defaultEffort !== undefined && !ids.has(capability.defaultEffort)) {
      context.addIssue({
        code: "custom",
        path: ["defaultEffort"],
        message: "default reasoning effort must be listed in efforts"
      });
    }
    if (
      capability.budget?.minTokens !== undefined &&
      capability.budget.maxTokens !== undefined &&
      capability.budget.minTokens > capability.budget.maxTokens
    ) {
      context.addIssue({
        code: "custom",
        path: ["budget"],
        message: "minimum reasoning budget cannot exceed maximum"
      });
    }
  });

export const DEFAULT_LEADERBOARD_LIVE_LIMIT = 1_000;
export const DEFAULT_LEADERBOARD_LIVE_TTL_HOURS = 24;
export const DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS = 14;

export const leaderboardConfigSchema = z
  .object({
    liveLimit: z.number().int().min(1).max(100_000).default(DEFAULT_LEADERBOARD_LIVE_LIMIT),
    liveTtlHours: z
      .number()
      .positive()
      .max(24 * 365)
      .default(DEFAULT_LEADERBOARD_LIVE_TTL_HOURS),
    durable: z.boolean().default(false),
    durableRetentionDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS)
  })
  .strict();

export const routerConfigSchema = z
  .object({
    providers: z
      .object({
        openai: providerPolicySchema.optional(),
        anthropic: providerPolicySchema.optional(),
        bedrock: providerPolicySchema.optional(),
        google: providerPolicySchema.optional(),
        openrouter: providerPolicySchema.optional(),
        cliproxy: providerPolicySchema.optional(),
        codex: providerPolicySchema.optional(),
        "claude-code": providerPolicySchema.optional()
      })
      .strict(),
    defaultModel: z.string().min(3).optional(),
    modelPolicy: modelPolicySchema.optional(),
    modelAliases: z.record(z.string().min(1), z.string().min(3)).optional(),
    reasoningCapabilities: z
      .record(z.string().min(3), reasoningCapabilityOverrideSchema)
      .optional(),
    leaderboard: leaderboardConfigSchema.optional()
  })
  .strict();

export type ModelPolicy = z.infer<typeof modelPolicySchema>;
export type ProviderPolicy = z.infer<typeof providerPolicySchema>;
export type RouterConfig = z.infer<typeof routerConfigSchema>;
export type LeaderboardConfig = z.infer<typeof leaderboardConfigSchema>;

/** Explicit provider ids in schema declaration order. */
export function configuredProviderIds(config: RouterConfig): ProviderId[] {
  return Object.keys(config.providers).filter((provider): provider is ProviderId =>
    (PROVIDER_IDS as readonly string[]).includes(provider)
  );
}

export function resolveLeaderboardConfig(
  config: Pick<RouterConfig, "leaderboard">
): LeaderboardConfig {
  return leaderboardConfigSchema.parse(config.leaderboard ?? {});
}

export function splitNamespacedModel(model: string): {
  provider: ProviderId;
  model: string;
} {
  const separator = model.indexOf("/");
  const source = separator < 0 ? "" : model.slice(0, separator);
  const nativeModel = separator < 0 ? "" : model.slice(separator + 1);
  if (
    !PROVIDER_IDS.includes(source as ProviderId) ||
    nativeModel.length === 0 ||
    nativeModel.startsWith("/")
  ) {
    throw new Error(`model "${model}" must use a supported provider/model namespace`);
  }
  return { provider: source as ProviderId, model: nativeModel };
}

export function parseRouterConfig(value: unknown): RouterConfig {
  const config = routerConfigSchema.parse(value);
  if (config.defaultModel !== undefined) {
    const selected = splitNamespacedModel(config.defaultModel);
    if (config.providers[selected.provider] === undefined) {
      throw new Error(`default model provider "${selected.provider}" is not configured`);
    }
  }
  for (const [alias, target] of Object.entries(config.modelAliases ?? {})) {
    if (alias.includes("/")) {
      throw new Error(
        `model alias "${alias}" must not contain "/"; alias keys must stay distinct from namespaced model ids`
      );
    }
    const selected = splitNamespacedModel(target);
    if (config.providers[selected.provider] === undefined) {
      throw new Error(
        `model alias "${alias}" targets "${target}" but provider "${selected.provider}" is not configured`
      );
    }
  }
  return config;
}
