import type { LeaderboardConfig } from "@velum-labs/routekit-config";
import { configuredProviderIds } from "@velum-labs/routekit-config";
import type { ModelInfo, RouteKitControlHandlers } from "@velum-labs/routekit-control";
import type { RunningRouter } from "@velum-labs/routekit-router";
import { ControlError, gatewayPath } from "@velum-labs/routekit-runtime";
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
  dataToken: string;
  runtimeState: DaemonRuntimeState;
  activeRouter(): RunningRouter;
  proxyUrl(): string;
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
        const response = await fetch(gatewayPath(options.proxyUrl(), "/v1/models"), {
          headers: { authorization: `Bearer ${options.dataToken}` }
        });
        if (!response.ok) {
          throw new ControlError({
            code: "unavailable",
            message: `gateway model discovery failed (${response.status})`
          });
        }
        const body = (await response.json()) as { data?: ModelInfo[]; default_model?: unknown };
        const models = (body.data ?? []).filter(
          (model) => params.provider === undefined || model.id.startsWith(`${params.provider}/`)
        );
        const result = {
          models,
          ...(options.runtimeState.config.defaultModel !== undefined
            ? { defaultModel: options.runtimeState.config.defaultModel }
            : typeof body.default_model === "string" &&
                models.some((model) => model.id === body.default_model)
              ? { defaultModel: body.default_model }
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
