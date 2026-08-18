import { Redacted } from "effect";

import type { PiAdapterConfig } from "../config.ts";

import { OPENROUTER_API_KEY_ENV } from "../../../../../contracts/internal/src/openrouter-auth.ts";

interface PiProcessConfig {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, Redacted.Redacted>>;
}

const buildPiProcess = (
  config: PiAdapterConfig,
  openRouterApiKey: Redacted.Redacted
): PiProcessConfig => ({
  args: config.args,
  command: config.piCommand,
  cwd: config.cwd,
  env: {
    ...Object.fromEntries(
      Object.entries(config.env).map(([name, value]) => [
        name,
        Redacted.make(value),
      ])
    ),
    [OPENROUTER_API_KEY_ENV]: openRouterApiKey,
  },
});

export { buildPiProcess };
