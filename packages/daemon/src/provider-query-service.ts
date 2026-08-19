import { configuredProviderIds } from "@velum-labs/routekit-config";
import type { ModelInfo } from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { ControlError } from "@velum-labs/routekit-runtime/control";
import { Effect } from "effect";
import { ActiveGateway } from "./services/active-gateway/service.js";
import { CallAttributions } from "./services/call-attributions/service.js";
import { DaemonEnv } from "./daemon-env-context.js";
import { DaemonState } from "./daemon-state-context.js";
import { Leaderboard } from "./leaderboard-context.js";
import {
  accountEntriesEffect,
  providerCredentialAvailable
} from "./daemon-maintenance.js";
import { writeSnapshotEffect } from "./daemon-state.js";
import {
  aggregateInspections,
  buildLeaderboardResult,
  defaultLeaderboardWindow
} from "./leaderboard.js";

type ProviderHandlers = Pick<
  EffectRouteKitControlHandlers,
  "providers.status" | "models.list" | "models.info" | "calls.inspect" | "calls.leaderboard"
>;

/** Owns provider health, catalog, inspection, and leaderboard queries. */
export class ProviderQueryService {
  handlers(): ProviderHandlers {
    return {
      "providers.status": (_params, context) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const state = yield* DaemonState;
          const gateway = yield* ActiveGateway;
          const accounts = yield* accountEntriesEffect(env.env);
          const live = yield* gateway.router()!.providerStatuses(context.signal);
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
          yield* writeSnapshotEffect(env.home, "health", "providers", {
            checkedAt: new Date().toISOString(),
            providers: result.providers
          });
          return result;
        }),
      "models.list": (params) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const state = yield* DaemonState;
          const gateway = yield* ActiveGateway;
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
          yield* writeSnapshotEffect(env.home, "catalog", "models", {
            updatedAt: new Date().toISOString(),
            defaultModel: result.defaultModel,
            models
          });
          return result;
        }),
      "models.info": (params) =>
        Effect.gen(function* () {
          const gateway = yield* ActiveGateway;
          const model = gateway.router()!.modelInfo(params.model);
          if (model === undefined) {
            return yield* Effect.fail(
              new ControlError({
                code: "not_found",
                message: `unknown model: ${params.model}`
              })
            );
          }
          return {
            ...model,
            capabilities: { ...model.capabilities },
            reasoning: model.reasoning === null ? null : { ...model.reasoning }
          };
        }),
      "calls.inspect": (params) =>
        Effect.gen(function* () {
          const attributions = yield* CallAttributions;
          const inspection = attributions.get(params.callId);
          if (inspection === undefined) {
            return yield* Effect.fail(
              new ControlError({
                code: "not_found",
                message: `unknown or expired model call: ${params.callId}`
              })
            );
          }
          return inspection;
        }),
      "calls.leaderboard": (params) =>
        Effect.gen(function* () {
          const attributions = yield* CallAttributions;
          const leaderboard = yield* Leaderboard;
          const config = leaderboard.config();
          const by = params.by ?? "principal";
          const sort = params.sort ?? "cost";
          const limit = params.limit ?? 20;
          const window = params.window ?? defaultLeaderboardWindow(config);
          const nowIso = new Date().toISOString();
          if (window === "live") {
            const aggregated = aggregateInspections(attributions.list(), {
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
              truncated: attributions.truncated(),
              budget: config,
              rows: aggregated.rows
            });
          }
          if (!config.durable) {
            return yield* Effect.fail(
              new ControlError({
                code: "bad_request",
                message:
                  "durable leaderboard rollups are disabled; set leaderboard.durable: true in router.yaml"
              })
            );
          }
          const aggregated = leaderboard.rollups.query({ by, sort, limit, window });
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
