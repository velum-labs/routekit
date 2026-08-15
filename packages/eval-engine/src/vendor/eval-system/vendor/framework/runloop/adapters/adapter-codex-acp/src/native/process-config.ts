import { fileURLToPath } from "node:url";

import type { CodexAdapterConfig } from "../config.ts";

interface CodexProcessConfig {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

const resolveCodexProcessBinary = (): string =>
  fileURLToPath(import.meta.resolve("@openai/codex/bin/codex.js"));

// Codex CLI owns its own authentication (ChatGPT login or API key configured
// outside ROUTEKIT_EVAL), so unlike Pi/Claude this adapter reads no Gateway secret
// and forwards no credential through the environment.
const buildCodexProcess = (config: CodexAdapterConfig): CodexProcessConfig => ({
  args: ["app-server", "--listen", "stdio://"],
  command: resolveCodexProcessBinary(),
  cwd: config.cwd,
  env: config.env ?? {},
});

export { buildCodexProcess, resolveCodexProcessBinary };
