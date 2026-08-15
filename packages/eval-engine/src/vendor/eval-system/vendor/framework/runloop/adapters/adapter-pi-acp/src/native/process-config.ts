import { Redacted } from "effect";

import type { PiAdapterConfig } from "../config.ts";

import { ROUTEKIT_EVAL_BEARER_TOKEN_ENV } from "../../../../../contracts/internal/src/gateway-auth.ts";

interface PiProcessConfig {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, Redacted.Redacted>>;
}

const buildPiProcess = (
  config: PiAdapterConfig,
  gatewayApiKey: Redacted.Redacted
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
    [ROUTEKIT_EVAL_BEARER_TOKEN_ENV]: gatewayApiKey,
  },
});

export { buildPiProcess };
