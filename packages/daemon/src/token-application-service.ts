import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { ControlError } from "@velum-labs/routekit-runtime/control";
import { encodeJoinCredential } from "@velum-labs/routekit-runtime/tokens";
import { Effect } from "effect";

import { DaemonEnv } from "./daemon-env-context.js";
import { daemonPublicRecordPath } from "./daemon-state.js";
import { Tokens } from "./services/tokens/service.js";

type TokenHandlers = Pick<
  EffectRouteKitControlHandlers,
  "tokens.issue" | "tokens.list" | "tokens.revoke"
>;

const tokenFailure = (error: unknown, operation: "issue" | "revoke"): ControlError => {
  const message = error instanceof Error ? error.message : String(error);
  return new ControlError({
    code:
      operation === "revoke" && message.startsWith("unknown token")
        ? "not_found"
        : "bad_request",
    message
  });
};

/** Binds token use cases to the control protocol. */
export class TokenApplicationService {
  handlers(): TokenHandlers {
    return {
      "tokens.issue": (params, context) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const tokens = yield* Tokens;
          const issued = yield* tokens
            .issue({
              label: params.label,
              plane: params.plane,
              role: "admin",
              createdBy: params.createdBy ?? context.principal?.label ?? "control"
            })
            .pipe(Effect.mapError((error) => tokenFailure(error, "issue")));
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
        }),
      "tokens.list": (params) =>
        Effect.gen(function* () {
          const tokens = yield* Tokens;
          return { tokens: yield* tokens.list(params.plane) };
        }),
      "tokens.revoke": (params) =>
        Effect.gen(function* () {
          const tokens = yield* Tokens;
          return yield* tokens
            .revoke(params.id)
            .pipe(Effect.mapError((error) => tokenFailure(error, "revoke")));
        })
    };
  }
}
