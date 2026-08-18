import type { ConfigSnapshot } from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { Effect } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { controlTry } from "./control-effect.js";
import {
  canonicalConfigDocument,
  parseConfigDocument,
  revisionConflict
} from "./daemon-maintenance.js";
import { DaemonEnv } from "./daemon-env-context.js";
import { DaemonState, type DaemonStateService } from "./daemon-state-context.js";
import { Generations } from "./services/generations/service.js";

type RouterHandlers = Pick<
  EffectRouteKitControlHandlers,
  "daemon.reload" | "config.get" | "config.update" | "config.import" | "providers.set"
>;

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
            yield* controlTry(() => {
              if (params.expectedRevision !== runtimeState.revisions.config) {
                revisionConflict(params.expectedRevision, runtimeState.revisions.config);
              }
            });
            yield* generations.replace(parseConfigDocument(params.document), params.document, {
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
              yield* controlTry(() => {
                if (
                  params.expectedRevision !== undefined &&
                  params.expectedRevision !== runtimeState.revisions.config
                ) {
                  revisionConflict(params.expectedRevision, runtimeState.revisions.config);
                }
              });
              const document = canonicalConfigDocument(env.configPath);
              yield* generations.replace(parseConfigDocument(document), document, {
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
              const document = yield* controlTry(() => {
                const raw = parseYaml(runtimeState.document) as Record<string, unknown>;
                const providers =
                  typeof raw.providers === "object" &&
                  raw.providers !== null &&
                  !Array.isArray(raw.providers)
                    ? { ...(raw.providers as Record<string, unknown>) }
                    : {};
                if (params.enabled) providers[params.provider] ??= {};
                else delete providers[params.provider];
                raw.providers = providers;
                return stringifyYaml(raw);
              });
              yield* generations.replace(parseConfigDocument(document), document, {
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
