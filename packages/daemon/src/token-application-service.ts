import type { RouteKitControlHandlers } from "@velum-labs/routekit-control";
import { ControlError, encodeJoinCredential, type TokenStore } from "@velum-labs/routekit-runtime";
import { daemonPublicRecordPath } from "./daemon-state.js";

type TokenHandlers = Pick<
  RouteKitControlHandlers,
  "tokens.issue" | "tokens.list" | "tokens.revoke"
>;

export type TokenApplicationServiceOptions = {
  home: string;
  tokens: TokenStore;
  dataTokenCache: Map<string, string>;
};

/** Owns data-plane and control-plane token issue, list, and revoke. */
export class TokenApplicationService {
  constructor(private readonly options: TokenApplicationServiceOptions) {}

  handlers(): TokenHandlers {
    const options = this.options;
    return {
      "tokens.issue": async (params, context) => {
        try {
          const issued = options.tokens.issue({
            label: params.label,
            plane: params.plane,
            role: "admin",
            createdBy: params.createdBy ?? context.principal?.label ?? "control"
          });
          if (issued.plane === "data") options.dataTokenCache.set(issued.label, issued.token);
          return {
            id: issued.id,
            label: issued.label,
            plane: issued.plane,
            role: issued.role,
            token: issued.token,
            ...(issued.plane === "control"
              ? {
                  joinCredential: encodeJoinCredential({
                    publicRecordPath: daemonPublicRecordPath(options.home),
                    token: issued.token
                  })
                }
              : {})
          };
        } catch (error) {
          throw new ControlError({
            code: "bad_request",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      },
      "tokens.list": async (params) => ({
        tokens: options.tokens.list(params.plane)
      }),
      "tokens.revoke": async (params) => {
        try {
          const revoked = options.tokens.revoke(params.id);
          if (revoked.plane === "data") options.dataTokenCache.delete(revoked.label);
          return revoked;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ControlError({
            code: message.startsWith("unknown token") ? "not_found" : "bad_request",
            message
          });
        }
      }
    };
  }
}
