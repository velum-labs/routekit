import type { FeatureLogger } from "../../../../../contracts/author/src/feature-logger.ts";

import { log } from "../../../../../contracts/author/src/logger.ts";

const emitSessionMapping = (
  logger: Pick<FeatureLogger, "info">,
  piSessionId: string,
  routeKitEvalSessionId: string
): void => {
  logger.info("Gateway Pi session mapped to RouteKitEval session", {
    routeKitEvalSessionId,
    piSessionId,
  });
};

const logSessionMapping = (piSessionId: string, routeKitEvalSessionId: string): void => {
  emitSessionMapping(log, piSessionId, routeKitEvalSessionId);
};

export { emitSessionMapping, logSessionMapping };
