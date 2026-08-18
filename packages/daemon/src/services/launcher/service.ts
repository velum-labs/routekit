import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { resolveCodexStartupModel } from "@velum-labs/routekit-gateway";
import { ControlError } from "@velum-labs/routekit-runtime/control";
import { Effect } from "effect";
import { dataTokenForPrincipal } from "../../daemon-state.js";
import { ActiveGateway, DataPlane, Tokens } from "../../effect/services.js";

type LauncherHandlers = Pick<EffectRouteKitControlHandlers, "launcher.prepare">;

export type LauncherApplicationServiceOptions = {
  listModels: EffectRouteKitControlHandlers["models.list"];
};

/** Owns coding-tool launch preparation against the live catalog. */
export class LauncherApplicationService {
  constructor(private readonly options: LauncherApplicationServiceOptions) {}

  handlers(): LauncherHandlers {
    const options = this.options;
    return {
      "launcher.prepare": (params, context) =>
        Effect.gen(function* () {
          const listed = yield* options.listModels(
            {},
            {
              signal: context.signal,
              requestId: "internal"
            }
          );
          return yield* Effect.gen(function* () {
            let model = params.model ?? listed.defaultModel ?? listed.models[0]?.id;
            let codexSelection;
            if (params.tool === "codex") {
              const gateway = yield* ActiveGateway;
              const candidates = listed.models.flatMap((entry) => {
                const info = gateway.router()!.modelInfo(entry.id);
                if (info === undefined) return [];
                return [
                  {
                    id: info.id,
                    nativeId: info.nativeModel,
                    provider: info.provider,
                    billingScope: info.billingMode,
                    ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
                    ...(info.providerPriority !== undefined
                      ? { providerPriority: info.providerPriority }
                      : {}),
                    ...(info.metadata?.architecture !== undefined
                      ? { architecture: info.metadata.architecture }
                      : {}),
                    ...(info.metadata?.supportedParameters !== undefined
                      ? { supportedParameters: info.metadata.supportedParameters }
                      : {}),
                    ...(info.reasoning !== null ? { reasoning: info.reasoning } : {})
                  }
                ];
              });
              const selected = yield* resolveCodexStartupModel({
                models: candidates,
                ...(listed.defaultModel !== undefined
                  ? { preferredModel: listed.defaultModel }
                  : {}),
                ...(params.model !== undefined ? { requestedModel: params.model } : {}),
                signal: context.signal
              }).pipe(
                Effect.mapError((error) => {
                  const message = error instanceof Error ? error.message : String(error);
                  return new ControlError({
                    code:
                      params.model !== undefined && message.startsWith("unknown model")
                        ? "not_found"
                        : "unavailable",
                    message
                  });
                })
              );
              model = selected.model;
              codexSelection = {
                compatibleModelIds: [...selected.compatibleModelIds],
                models: [...selected.models]
              };
            }
            if (model === undefined || !listed.models.some((entry) => entry.id === model)) {
              return yield* Effect.fail(
                new ControlError({
                  code: "not_found",
                  message:
                    params.model === undefined
                      ? "no model is available"
                      : `unknown model: ${params.model}`
                })
              );
            }
            const gateway = yield* ActiveGateway;
            const tokens = yield* Tokens;
            const dataPlane = yield* DataPlane;
            return {
              tool: params.tool,
              model,
              gatewayUrl: gateway.dataUrl() ?? "",
              authToken: dataTokenForPrincipal(
                tokens,
                dataPlane.cache,
                dataPlane.token,
                context.principal
              ),
              env: {},
              ...(codexSelection !== undefined ? { codexSelection } : {})
            };
          });
        })
    };
  }
}
