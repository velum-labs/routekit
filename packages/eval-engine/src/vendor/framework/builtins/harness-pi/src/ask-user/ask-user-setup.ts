import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolvePiAgentDir } from "../openrouter-attribution/openrouter-attribution.ts";

import askUserExtensionSource from "./ask-user.ts.txt";

const ASK_USER_DIR = "ask-user";
const ASK_USER_FILENAME = "ask-user.ts";

const materializeAskUserExtension = async (
  env: NodeJS.ProcessEnv
): Promise<string | undefined> => {
  const directory = join(resolvePiAgentDir(env), ASK_USER_DIR);
  const target = join(directory, ASK_USER_FILENAME);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(target, askUserExtensionSource, "utf-8");
    return target;
  } catch {
    return undefined;
  }
};

export { materializeAskUserExtension };
