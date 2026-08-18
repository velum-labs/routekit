import { Context } from "effect";

import type { EvalSessionManager } from "../eval-session-manager/service.js";

export class EvalSessions extends Context.Service<EvalSessions, EvalSessionManager>()(
  "@velum-labs/routekit-daemon/EvalSessions"
) {}
