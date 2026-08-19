import type { ConfigSnapshot } from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { ControlError } from "@velum-labs/routekit-runtime/control";
import { toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  canonicalConfigDocumentEffect,
  parseConfigDocumentEffect
} from "./daemon-maintenance.js";
import { DaemonEnv } from "./daemon-env-context.js";
import { DaemonState, type DaemonStateService } from "./daemon-state-context.js";
import { Generations } from "./services/generations/service.js";

type RouterHandlers = Pick<
  EffectRouteKitControlHandlers,
  "daemon.reload" | "config.get" | "config.update" | "config.import" | "providers.set"
>;

const updateProviderDocument = (
  document: string,
  provider: string,
  enabled: boolean
) =>
  Effect.try({
    try: () => {
      const raw = parseYaml(document) as Record<string, unknown>;
      const providers =
        typeof raw.providers === "object" &&
        raw.providers !== null &&
        !Array.isArray(raw.providers)
          ? { ...(raw.providers as Record<string, unknown>) }
          : {};
      if (enabled) providers[provider] ??= {};
      else delete providers[provider];
      raw.providers = providers;
      return stringifyYaml(raw);
    },
    catch: toRouteKitFailure
  });

const revisionConflict = (expected: number, actual: number) =>
  new ControlError({
    code: "conflict",
    message: `revision conflict: expected ${expected}, current ${actual}`,
    details: { expected, actual }
  });

/** Owns config mutations and generation publication use cases. */
export class RouterGenerationService {
  handlers(): RouterHandlers {
    const snapshot = (configPath: string, runtimeState: DaemonStateService): ConfigSnapshot => ({
      path: configPath,
      document: runtimeState.document,
      revision: runtimeState.revisions.config
    });
    const update = (params: { expectedRevision: number; document: string }) =>
      Effect.gen(function* () {
        const env = yield* DaemonEnv;
        const runtimeState = yield* DaemonState;
        const generations = yield* Generations;
        return yield* runtimeState.serializeEffect(
          Effect.gen(function* () {
            if (params.expectedRevision !== runtimeState.revisions.config) {
              return yield* Effect.fail(
                revisionConflict(params.expectedRevision, runtimeState.revisions.config)
              );
            }
            const config = yield* parseConfigDocumentEffect(params.document);
            yield* generations.replace(config, params.document, {
              write: true,
              configRevision: true
            });
            return snapshot(env.configPath, runtimeState);
          })
        );
      });
    return {
      "daemon.reload": (params) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const runtimeState = yield* DaemonState;
          const generations = yield* Generations;
          return yield* runtimeState.serializeEffect(
            Effect.gen(function* () {
              if (
                params.expectedRevision !== undefined &&
                params.expectedRevision !== runtimeState.revisions.config
              ) {
                return yield* Effect.fail(
                  revisionConflict(params.expectedRevision, runtimeState.revisions.config)
                );
              }
              const document = yield* canonicalConfigDocumentEffect(env.configPath);
              const config = yield* parseConfigDocumentEffect(document);
              yield* generations.replace(config, document, {
                write: false,
                configRevision: true
              });
              return {
                reloaded: true as const,
                configRevision: runtimeState.revisions.config,
                accountRevision: runtimeState.revisions.accounts
              };
            })
          );
        }),
      "config.get": () =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const runtimeState = yield* DaemonState;
          return snapshot(env.configPath, runtimeState);
        }),
      "config.update": update,
      "config.import": update,
      "providers.set": (params) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const runtimeState = yield* DaemonState;
          const generations = yield* Generations;
          return yield* runtimeState.serializeEffect(
            Effect.gen(function* () {
              const document = yield* updateProviderDocument(
                runtimeState.document,
                params.provider,
                params.enabled
              );
              const config = yield* parseConfigDocumentEffect(document);
              yield* generations.replace(config, document, {
                write: true,
                configRevision: true
              });
              return snapshot(env.configPath, runtimeState);
            })
          );
        })
    };
  }
}
