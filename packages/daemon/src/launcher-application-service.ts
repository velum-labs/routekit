import type { RouteKitControlHandlers } from "@velum-labs/routekit-control";
import { resolveCodexStartupModel } from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import { ControlError, type TokenStore } from "@velum-labs/routekit-runtime";
import { dataTokenForPrincipal } from "./daemon-state.js";

type LauncherHandlers = Pick<RouteKitControlHandlers, "launcher.prepare">;

export type LauncherApplicationServiceOptions = {
  dataUrl: string;
  tokens: TokenStore;
  dataTokenCache: Map<string, string>;
  dataAuth: { token: string; path: string };
  activeRouter: () => RunningRouter | undefined;
  listModels: RouteKitControlHandlers["models.list"];
};

/** Owns coding-tool launch preparation against the live catalog. */
export class LauncherApplicationService {
  constructor(private readonly options: LauncherApplicationServiceOptions) {}

  handlers(): LauncherHandlers {
    const options = this.options;
    return {
      "launcher.prepare": async (params, context) => {
        const listed = await options.listModels(
          {},
          {
            signal: context.signal,
            requestId: "internal"
          }
        );
        let model = params.model ?? listed.defaultModel ?? listed.models[0]?.id;
        let codexSelection;
        if (params.tool === "codex") {
          const candidates = listed.models.flatMap((entry) => {
            const info = options.activeRouter()!.modelInfo(entry.id);
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
          try {
            const selected = await resolveCodexStartupModel({
              models: candidates,
              ...(listed.defaultModel !== undefined ? { preferredModel: listed.defaultModel } : {}),
              ...(params.model !== undefined ? { requestedModel: params.model } : {}),
              signal: context.signal
            });
            model = selected.model;
            codexSelection = {
              compatibleModelIds: [...selected.compatibleModelIds],
              models: [...selected.models]
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ControlError({
              code:
                params.model !== undefined && message.startsWith("unknown model")
                  ? "not_found"
                  : "unavailable",
              message
            });
          }
        }
        if (model === undefined || !listed.models.some((entry) => entry.id === model)) {
          throw new ControlError({
            code: "not_found",
            message:
              params.model === undefined
                ? "no model is available"
                : `unknown model: ${params.model}`
          });
        }
        return {
          tool: params.tool,
          model,
          gatewayUrl: options.dataUrl,
          authToken: dataTokenForPrincipal(
            options.tokens,
            options.dataTokenCache,
            options.dataAuth.token,
            context.principal
          ),
          env: {},
          ...(codexSelection !== undefined ? { codexSelection } : {})
        };
      }
    };
  }
}
