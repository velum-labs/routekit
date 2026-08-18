import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolvePiAgentDir } from "../openrouter-attribution/openrouter-attribution.ts";

import source from "./openrouter-session-attribution.ts.txt";

const materializeOpenRouterSessionAttributionExtension = (
  env: NodeJS.ProcessEnv
): Promise<string | undefined> => {
  const directory = join(
    resolvePiAgentDir(env),
    "openrouter-session-attribution"
  );
  const target = join(directory, "openrouter-session-attribution.ts");
  return mkdir(directory, { recursive: true })
    .then(() => writeFile(target, source, "utf-8"))
    .then(() => target)
    .catch(() => void 0);
};

export { materializeOpenRouterSessionAttributionExtension };
