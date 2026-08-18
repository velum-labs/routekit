import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { ControlError } from "@velum-labs/routekit-runtime/control";
import { Effect } from "effect";

import { ActiveGateway } from "../active-gateway/service.js";
import { DaemonEnv } from "../daemon-env/service.js";
import { EvalSessions } from "../eval-sessions/service.js";

type EvalSessionHandlers = Pick<
  EffectRouteKitControlHandlers,
  "evalSession.open" | "evalSession.close"
>;

/** Owns short-lived, model-restricted eval data-plane sessions. */
export class EvalSessionApplicationService {
  handlers(): EvalSessionHandlers {
    return {
      "evalSession.open": (params) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const gateway = yield* ActiveGateway;
          const sessions = yield* EvalSessions;
          const gatewayUrl = gateway.dataUrl();
          if (gatewayUrl === undefined) {
            return yield* Effect.fail(
              new ControlError({
                code: "unavailable",
                message: "eval session cannot open before the data gateway is ready"
              })
            );
          }
          return sessions.open({
            ...params,
            gatewayUrl,
            targetIdentity: `routekit-generation:${env.generation}`
          });
        }),
      "evalSession.close": (params) =>
        Effect.gen(function* () {
          const sessions = yield* EvalSessions;
          return {
            sessionId: params.sessionId,
            closed: sessions.close(params.sessionId)
          };
        })
    };
  }
}
