import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensurePiOpenRouterAttribution } from "./vendor/framework/builtins/harness-pi/src/openrouter-attribution/openrouter-attribution.ts";
import {
  applyHostProviderEnv,
  EVAL_API_BASE_URL_ENV,
  OPENROUTER_API_KEY_ENV,
  PI_CODING_AGENT_DIR_ENV,
  trimEnv,
} from "./host-env.ts";

const writeSecretJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
};

/**
 * Seed the isolated Ori home so a Claude-spawned `ori eval` / Pi child still
 * authenticates against the host bridge after the author shell drops env.
 */
const ensureIsolatedOriChildAuth = async (
  env: Record<string, string | undefined>,
  workspace?: string,
): Promise<void> => {
  applyHostProviderEnv(env);
  const home = trimEnv(env.HOME);
  const key = trimEnv(env[OPENROUTER_API_KEY_ENV]);
  const apiBase = trimEnv(env[EVAL_API_BASE_URL_ENV]);
  if (home !== undefined && key !== undefined) {
    const dir = join(home, ".ori");
    await mkdir(dir, { recursive: true });
    await writeSecretJson(join(dir, "credentials.json"), {
      createdAt: new Date().toISOString(),
      key,
      userId: null,
    });
    const piDir = trimEnv(env[PI_CODING_AGENT_DIR_ENV]) ?? join(dir, "pi-agent");
    await mkdir(piDir, { recursive: true });
    await writeSecretJson(join(piDir, "auth.json"), {
      openrouter: { type: "api_key", key },
    });
  }
  if (workspace !== undefined && key !== undefined) {
    const workspaceOri = join(workspace, ".ori");
    await mkdir(workspaceOri, { recursive: true });
    await writeSecretJson(join(workspaceOri, "credentials.json"), {
      createdAt: new Date().toISOString(),
      key,
      userId: null,
    });
    const dotenvLines = [`${OPENROUTER_API_KEY_ENV}=${key}`];
    if (apiBase !== undefined) dotenvLines.push(`${EVAL_API_BASE_URL_ENV}=${apiBase}`);
    await writeFile(join(workspace, ".env"), `${dotenvLines.join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  await ensurePiOpenRouterAttribution({ env });
};

export { ensureIsolatedOriChildAuth };
