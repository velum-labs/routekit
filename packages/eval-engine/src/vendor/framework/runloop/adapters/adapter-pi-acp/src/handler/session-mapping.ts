import type { FeatureLogger } from "../../../../../contracts/author/src/feature-logger.ts";

import { log } from "../../../../../contracts/author/src/logger.ts";

const emitSessionMapping = (
  logger: Pick<FeatureLogger, "info">,
  piSessionId: string,
  oriSessionId: string
): void => {
  logger.info("OpenRouter Pi session mapped to Ori session", {
    oriSessionId,
    piSessionId,
  });
};

const logSessionMapping = (piSessionId: string, oriSessionId: string): void => {
  emitSessionMapping(log, piSessionId, oriSessionId);
};

export { emitSessionMapping, logSessionMapping };
