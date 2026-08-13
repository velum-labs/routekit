import type { RouterConfig } from "@velum-labs/routekit-config";
import type { ConfigSnapshot } from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { controlTry, controlTryPromise } from "./control-effect.js";
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
  serializeMutation<T>(operation: () => Promise<T>): Promise<T>;
  replaceRouter(
    config: RouterConfig,
    document: string,
    options: DaemonGenerationMutation
  ): Promise<void>;
};

/** Owns config mutations and generation publication use cases. */
export class RouterGenerationService {
  constructor(private readonly options: RouterGenerationServiceOptions) {}

  handlers(): RouterHandlers {
    const { configPath, runtimeState, serializeMutation, replaceRouter } = this.options;
    const snapshot = (): ConfigSnapshot => ({
      path: configPath,
      document: runtimeState.document,
      revision: runtimeState.revisions.config
    });
    const update = (params: { expectedRevision: number; document: string }) =>
      controlTryPromise(async () => {
        await serializeMutation(async () => {
          if (params.expectedRevision !== runtimeState.revisions.config) {
            revisionConflict(params.expectedRevision, runtimeState.revisions.config);
          }
          await replaceRouter(parseConfigDocument(params.document), params.document, {
            write: true,
            configRevision: true
          });
        });
        return snapshot();
      });
    return {
      "daemon.reload": (params) =>
        controlTryPromise(async () => {
          await serializeMutation(async () => {
            if (
              params.expectedRevision !== undefined &&
              params.expectedRevision !== runtimeState.revisions.config
            ) {
              revisionConflict(params.expectedRevision, runtimeState.revisions.config);
            }
            const document = canonicalConfigDocument(configPath);
            await replaceRouter(parseConfigDocument(document), document, {
              write: false,
              configRevision: true
            });
          });
          return {
            reloaded: true,
            configRevision: runtimeState.revisions.config,
            accountRevision: runtimeState.revisions.accounts
          };
        }),
      "config.get": () => controlTry(() => snapshot()),
      "config.update": update,
      "config.import": update,
      "providers.set": (params) =>
        controlTryPromise(async () => {
          await serializeMutation(async () => {
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
            const document = stringifyYaml(raw);
            await replaceRouter(parseConfigDocument(document), document, {
              write: true,
              configRevision: true
            });
          });
          return snapshot();
        })
    };
  }
}
