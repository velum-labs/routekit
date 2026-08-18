import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { ControlError } from "@velum-labs/routekit-runtime/control";
import type { TokenStore } from "@velum-labs/routekit-runtime/tokens";
import { encodeJoinCredential } from "@velum-labs/routekit-runtime/tokens";
import { Context, Effect, Layer } from "effect";
import { controlTry } from "../../control-effect.js";
import { daemonPublicRecordPath } from "../../daemon-state.js";
import { DaemonEnv } from "../../daemon-env-context.js";

export type TokensService = {
  issue: TokenStore["issue"];
  list: TokenStore["list"];
  revoke: TokenStore["revoke"];
  resolve: TokenStore["resolve"];
  dataTokenForPrincipal(
    ownerToken: string,
    principal: { id: string; label: string; role: string } | undefined
  ): string;
};

export class Tokens extends Context.Service<Tokens, TokensService>()(
  "@velum-labs/routekit-daemon/Tokens"
) {
  static layer(store: TokenStore): Layer.Layer<Tokens> {
    return Layer.effect(
      Tokens,
      Effect.sync(() => {
        const dataTokens = new Map<string, string>();
        return Tokens.of({
          issue: store.issue,
          list: store.list,
          revoke: (id) => {
            const revoked = store.revoke(id);
            if (revoked.plane === "data") dataTokens.delete(revoked.label);
            return revoked;
          },
          resolve: store.resolve,
          dataTokenForPrincipal: (ownerToken, principal) => {
            if (
              principal === undefined ||
              principal.role === "ephemeral" ||
              principal.role === "owner"
            ) {
              return ownerToken;
            }
            const label = `${principal.label}-data`;
            const cached = dataTokens.get(label);
            if (cached !== undefined) return cached;
            const existing = store.findByLabel(label, "data");
            if (existing !== undefined) store.revoke(existing.id);
            const issued = store.issue({
              label,
              plane: "data",
              role: "admin",
              createdBy: principal.label
            });
            dataTokens.set(label, issued.token);
            return issued.token;
          }
        });
      })
    );
  }
}

type TokenHandlers = Pick<
  EffectRouteKitControlHandlers,
  "tokens.issue" | "tokens.list" | "tokens.revoke"
>;

/** Owns data-plane and control-plane token issue, list, revoke, and cache invalidation. */
export class TokenApplicationService {
  handlers(): TokenHandlers {
    return {
      "tokens.issue": (params, context) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const tokens = yield* Tokens;
          return yield* controlTry(() => {
            try {
              const issued = tokens.issue({
                label: params.label,
                plane: params.plane,
                role: "admin",
                createdBy: params.createdBy ?? context.principal?.label ?? "control"
              });
              return {
                id: issued.id,
                label: issued.label,
                plane: issued.plane,
                role: issued.role,
                token: issued.token,
                ...(issued.plane === "control"
                  ? {
                      joinCredential: encodeJoinCredential({
                        publicRecordPath: daemonPublicRecordPath(env.home),
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
          });
        }),
      "tokens.list": (params) =>
        Effect.gen(function* () {
          const tokens = yield* Tokens;
          return yield* controlTry(() => ({ tokens: tokens.list(params.plane) }));
        }),
      "tokens.revoke": (params) =>
        Effect.gen(function* () {
          const tokens = yield* Tokens;
          return yield* controlTry(() => {
            try {
              return tokens.revoke(params.id);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new ControlError({
                code: message.startsWith("unknown token") ? "not_found" : "bad_request",
                message
              });
            }
          });
        })
    };
  }
}
