import type { LeaderboardConfig } from "@velum-labs/routekit-config";
import { configuredProviderIds } from "@velum-labs/routekit-config";
import type { ModelInfo, RouteKitControlHandlers } from "@velum-labs/routekit-control";
import type { RunningRouter } from "@velum-labs/routekit-router";
import { ControlError } from "@velum-labs/routekit-runtime";
import type { CallAttributionStore } from "./call-attribution-store.js";
import { accountEntries, providerCredentialAvailable } from "./daemon-maintenance.js";
import type { DaemonRuntimeState } from "./daemon-runtime-state.js";
import {
  aggregateInspections,
  buildLeaderboardResult,
  defaultLeaderboardWindow,
  type LeaderboardRollupStore
} from "./leaderboard.js";

type ProviderHandlers = Pick<
  RouteKitControlHandlers,
  "providers.status" | "models.list" | "models.info" | "calls.inspect" | "calls.leaderboard"
>;

export type ProviderQueryServiceOptions = {
  env: NodeJS.ProcessEnv;
  runtimeState: DaemonRuntimeState;
  activeRouter(): RunningRouter;
  callAttributions: CallAttributionStore;
  leaderboardRollups: LeaderboardRollupStore;
  leaderboardConfig(): LeaderboardConfig;
  writeSnapshot(category: "catalog" | "health", name: string, value: unknown): void;
};

/** Owns provider health, catalog, inspection, and leaderboard queries. */
export class ProviderQueryService {
  constructor(private readonly options: ProviderQueryServiceOptions) {}

  handlers(): ProviderHandlers {
    const options = this.options;
    return {
      "providers.status": async (_params, context) => {
        const accounts = accountEntries(options.env);
        const live = await options.activeRouter().providerStatuses(context.signal);
        const result = {
          providers: configuredProviderIds(options.runtimeState.config).map((provider) => {
            const status = live.find((entry) => entry.provider === provider);
            return {
              provider,
              configured: true,
              credentialAvailable: providerCredentialAvailable(provider, accounts, options.env),
              models: status?.models ?? [],
              ...(status?.error !== undefined ? { error: status.error } : {})
            };
          })
        };
        options.writeSnapshot("health", "providers", {
          checkedAt: new Date().toISOString(),
          providers: result.providers
        });
        return result;
      },
      "models.list": async (params) => {
        const catalog = options.activeRouter().modelCatalog();
        const models: ModelInfo[] = catalog
          .filter(
            (model) => params.provider === undefined || model.id.startsWith(`${params.provider}/`)
          )
          .map((model) => ({
            id: model.id,
            provider: model.provider,
            owned_by: model.provider,
            routekit_provider_priority: model.providerPriority,
            capabilities: { ...model.capabilities },
            ...(model.metadata?.architecture !== undefined
              ? {
                  architecture: {
                    modality: model.metadata.architecture.modality,
                    input_modalities: model.metadata.architecture.inputModalities,
                    output_modalities: model.metadata.architecture.outputModalities
                  }
                }
              : {}),
            ...(model.metadata?.supportedParameters !== undefined
              ? { supported_parameters: model.metadata.supportedParameters }
              : {}),
            reasoning:
              model.reasoning === null || model.reasoning === undefined
                ? undefined
                : { ...model.reasoning }
          }));
        const result = {
          models,
          ...(options.runtimeState.config.defaultModel !== undefined
            ? { defaultModel: options.runtimeState.config.defaultModel }
            : catalog.some((model) => model.default)
              ? { defaultModel: catalog.find((model) => model.default)?.id }
              : {}),
          revision: options.runtimeState.revisions.config
        };
        options.writeSnapshot("catalog", "models", {
          updatedAt: new Date().toISOString(),
          defaultModel: result.defaultModel,
          models
        });
        return result;
      },
      "models.info": async (params) => {
        const model = options.activeRouter().modelInfo(params.model);
        if (model === undefined) {
          throw new ControlError({ code: "not_found", message: `unknown model: ${params.model}` });
        }
        return {
          ...model,
          capabilities: { ...model.capabilities },
          reasoning: model.reasoning === null ? null : { ...model.reasoning }
        };
      },
      "calls.inspect": async (params) => {
        const inspection = options.callAttributions.get(params.callId);
        if (inspection === undefined) {
          throw new ControlError({
            code: "not_found",
            message: `unknown or expired model call: ${params.callId}`
          });
        }
        return inspection;
      },
      "calls.leaderboard": async (params) => {
        const config = options.leaderboardConfig();
        const by = params.by ?? "principal";
        const sort = params.sort ?? "cost";
        const limit = params.limit ?? 20;
        const window = params.window ?? defaultLeaderboardWindow(config);
        const nowIso = new Date().toISOString();
        if (window === "live") {
          const aggregated = aggregateInspections(options.callAttributions.list(), {
            by,
            sort,
            limit
          });
          return buildLeaderboardResult({
            by,
            sort,
            source: "live",
            windowStart: aggregated.windowStart ?? nowIso,
            windowEnd: aggregated.windowEnd ?? nowIso,
            sampleSize: aggregated.sampleSize,
            truncated: options.callAttributions.truncated(),
            budget: config,
            rows: aggregated.rows
          });
        }
        if (!config.durable) {
          throw new ControlError({
            code: "bad_request",
            message:
              "durable leaderboard rollups are disabled; set leaderboard.durable: true in router.yaml"
          });
        }
        const aggregated = options.leaderboardRollups.query({ by, sort, limit, window });
        return buildLeaderboardResult({
          by,
          sort,
          source: "durable",
          windowStart: aggregated.windowStart,
          windowEnd: aggregated.windowEnd,
          sampleSize: aggregated.sampleSize,
          truncated: false,
          budget: config,
          rows: aggregated.rows
        });
      }
    };
  }
}
