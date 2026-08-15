import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolvePiAgentDir } from "../gateway-attribution/gateway-attribution.ts";

import source from "./gateway-session-attribution.ts.txt";

const materializeGatewaySessionAttributionExtension = (
  env: NodeJS.ProcessEnv
): Promise<string | undefined> => {
  const directory = join(
    resolvePiAgentDir(env),
    "gateway-session-attribution"
  );
  const target = join(directory, "gateway-session-attribution.ts");
  return mkdir(directory, { recursive: true })
    .then(() => writeFile(target, source, "utf-8"))
    .then(() => target)
    .catch(() => void 0);
};

export { materializeGatewaySessionAttributionExtension };
