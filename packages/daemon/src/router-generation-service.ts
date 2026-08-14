import type { RouterConfig } from "@velum-labs/routekit-config";
import type { ConfigSnapshot } from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { controlTry } from "./control-effect.js";
import type { DaemonGenerationMutation } from "./daemon-generations.js";
import {
  canonicalConfigDocument,
  parseConfigDocument,
  revisionConflict
} from "./daemon-maintenance.js";
import type { DaemonRuntimeState } from "./daemon-runtime-state.js";

type RouterHandlers = Pick<
  EffectRouteKitControlHandlers,
  "daemon.reload" | "config.get" | "config.update" | "config.import" | "providers.set"
>;

export type RouterGenerationServiceOptions = {
  configPath: string;
  runtimeState: DaemonRuntimeState;
  replaceRouter(
    config: RouterConfig,
    document: string,
    options: DaemonGenerationMutation
  ): Effect.Effect<void, Error, RouteKitPlatform>;
};

/** Owns config mutations and generation publication use cases. */
export class RouterGenerationService {
  constructor(private readonly options: RouterGenerationServiceOptions) {}

  handlers(): RouterHandlers {
    const { configPath, runtimeState, replaceRouter } = this.options;
    const snapshot = (): ConfigSnapshot => ({
      path: configPath,
      document: runtimeState.document,
      revision: runtimeState.revisions.config
    });
    const update = (params: { expectedRevision: number; document: string }) =>
      runtimeState.serializeEffect(
        Effect.gen(function* () {
          yield* controlTry(() => {
            if (params.expectedRevision !== runtimeState.revisions.config) {
              revisionConflict(params.expectedRevision, runtimeState.revisions.config);
            }
          });
          yield* replaceRouter(parseConfigDocument(params.document), params.document, {
            write: true,
            configRevision: true
          });
          return snapshot();
        })
      );
    return {
      "daemon.reload": (params) =>
        runtimeState.serializeEffect(
          Effect.gen(function* () {
            yield* controlTry(() => {
              if (
                params.expectedRevision !== undefined &&
                params.expectedRevision !== runtimeState.revisions.config
              ) {
                revisionConflict(params.expectedRevision, runtimeState.revisions.config);
              }
            });
            const document = canonicalConfigDocument(configPath);
            yield* replaceRouter(parseConfigDocument(document), document, {
              write: false,
              configRevision: true
            });
            return {
              reloaded: true,
              configRevision: runtimeState.revisions.config,
              accountRevision: runtimeState.revisions.accounts
            };
          })
        ),
      "config.get": () => controlTry(() => snapshot()),
      "config.update": update,
      "config.import": update,
      "providers.set": (params) =>
        runtimeState.serializeEffect(
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
            yield* replaceRouter(parseConfigDocument(document), document, {
              write: true,
              configRevision: true
            });
            return snapshot();
          })
        )
    };
  }
}
