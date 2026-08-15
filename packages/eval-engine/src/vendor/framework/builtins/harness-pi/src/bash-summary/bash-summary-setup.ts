import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolvePiAgentDir } from "../openrouter-attribution/openrouter-attribution.ts";

import bashSummaryExtensionSource from "./bash-summary.ts.txt";

const BASH_SUMMARY_DIR = "bash-summary";
const BASH_SUMMARY_FILENAME = "bash-summary.ts";

const materializeBashSummaryExtension = async (
  env: NodeJS.ProcessEnv
): Promise<string | undefined> => {
  const directory = join(resolvePiAgentDir(env), BASH_SUMMARY_DIR);
  const target = join(directory, BASH_SUMMARY_FILENAME);
  const written = await mkdir(directory, { recursive: true })
    .then(() => writeFile(target, bashSummaryExtensionSource, "utf-8"))
    .then(() => true)
    .catch(() => false);
  return written ? target : undefined;
};

export { materializeBashSummaryExtension };
