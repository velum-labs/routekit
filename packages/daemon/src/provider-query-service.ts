import type { LeaderboardConfig } from "@velum-labs/routekit-config";
import { configuredProviderIds } from "@velum-labs/routekit-config";
import type { ModelInfo } from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { ControlError } from "@velum-labs/routekit-runtime";
import { Effect } from "effect";
import type { CallAttributionStore } from "./call-attribution-store.js";
import { controlTry } from "./control-effect.js";
import { ActiveGateway, DaemonEnv, DaemonState } from "./effect/services.js";
import { accountEntries, providerCredentialAvailable } from "./daemon-maintenance.js";
import { writeSnapshot } from "./daemon-state.js";
import {
  aggregateInspections,
  buildLeaderboardResult,
  defaultLeaderboardWindow,
  type LeaderboardRollupStore
} from "./leaderboard.js";

type ProviderHandlers = Pick<
  EffectRouteKitControlHandlers,
  "providers.status" | "models.list" | "models.info" | "calls.inspect" | "calls.leaderboard"
>;

export type ProviderQueryServiceOptions = {
  callAttributions: CallAttributionStore;
  leaderboardRollups: LeaderboardRollupStore;
  leaderboardConfig(): LeaderboardConfig;
};

/** Owns provider health, catalog, inspection, and leaderboard queries. */
export class ProviderQueryService {
  constructor(private readonly options: ProviderQueryServiceOptions) {}

  handlers(): ProviderHandlers {
    const options = this.options;
    return {
      "providers.status": (_params, context) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const state = yield* DaemonState;
          const gateway = yield* ActiveGateway;
          const accounts = yield* controlTry(() => accountEntries(env.env));
          const live = yield* gateway.router()!.providerStatuses(context.signal);
          return yield* controlTry(() => {
            const result = {
              providers: configuredProviderIds(state.config).map((provider) => {
                const status = live.find((entry) => entry.provider === provider);
                return {
                  provider,
                  configured: true,
                  credentialAvailable: providerCredentialAvailable(provider, accounts, env.env),
                  models: status?.models ?? [],
                  ...(status?.error !== undefined ? { error: status.error } : {})
                };
              })
            };
            writeSnapshot(env.home, "health", "providers", {
              checkedAt: new Date().toISOString(),
              providers: result.providers
            });
            return result;
          });
        }),
      "models.list": (params) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const state = yield* DaemonState;
          const gateway = yield* ActiveGateway;
          return yield* controlTry(() => {
            const catalog = gateway.router()!.modelCatalog();
            const models: ModelInfo[] = catalog
              .filter(
                (model) =>
                  params.provider === undefined || model.id.startsWith(`${params.provider}/`)
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
              ...(state.config.defaultModel !== undefined
                ? { defaultModel: state.config.defaultModel }
                : catalog.some((model) => model.default)
                  ? { defaultModel: catalog.find((model) => model.default)?.id }
                  : {}),
              revision: state.revisions.config
            };
            writeSnapshot(env.home, "catalog", "models", {
              updatedAt: new Date().toISOString(),
              defaultModel: result.defaultModel,
              models
            });
            return result;
          });
        }),
      "models.info": (params) =>
        Effect.gen(function* () {
          const gateway = yield* ActiveGateway;
          return yield* controlTry(() => {
            const model = gateway.router()!.modelInfo(params.model);
            if (model === undefined) {
              throw new ControlError({
                code: "not_found",
                message: `unknown model: ${params.model}`
              });
            }
            return {
              ...model,
              capabilities: { ...model.capabilities },
              reasoning: model.reasoning === null ? null : { ...model.reasoning }
            };
          });
        }),
      "calls.inspect": (params) =>
        controlTry(() => {
          const inspection = options.callAttributions.get(params.callId);
          if (inspection === undefined) {
            throw new ControlError({
              code: "not_found",
              message: `unknown or expired model call: ${params.callId}`
            });
          }
          return inspection;
        }),
      "calls.leaderboard": (params) =>
        controlTry(() => {
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
        })
    };
  }
}
