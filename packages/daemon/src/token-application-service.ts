import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { ControlError, encodeJoinCredential } from "@velum-labs/routekit-runtime";
import { Effect } from "effect";
import { controlTry } from "./control-effect.js";
import { daemonPublicRecordPath } from "./daemon-state.js";
import { DaemonEnv, DataPlane, Tokens } from "./effect/services.js";

type TokenHandlers = Pick<
  EffectRouteKitControlHandlers,
  "tokens.issue" | "tokens.list" | "tokens.revoke"
>;

/** Owns data-plane and control-plane token issue, list, and revoke. */
export class TokenApplicationService {
  handlers(): TokenHandlers {
    return {
      "tokens.issue": (params, context) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const tokens = yield* Tokens;
          const dataPlane = yield* DataPlane;
          return yield* controlTry(() => {
            try {
              const issued = tokens.issue({
                label: params.label,
                plane: params.plane,
                role: "admin",
                createdBy: params.createdBy ?? context.principal?.label ?? "control"
              });
              if (issued.plane === "data") dataPlane.cache.set(issued.label, issued.token);
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
          return yield* controlTry(() => ({
            tokens: tokens.list(params.plane)
          }));
        }),
      "tokens.revoke": (params) =>
        Effect.gen(function* () {
          const tokens = yield* Tokens;
          const dataPlane = yield* DataPlane;
          return yield* controlTry(() => {
            try {
              const revoked = tokens.revoke(params.id);
              if (revoked.plane === "data") dataPlane.cache.delete(revoked.label);
              return revoked;
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
