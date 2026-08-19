import { CliError } from "@velum-labs/routekit-cli-core";

export type GatewayServeCliOptions = {
  host: string;
  port: string;
  authToken?: string;
  portless?: boolean;
  drainGrace?: string;
};

export const DEFAULT_DRAIN_GRACE_SECONDS = 30;

export function drainGraceMs(raw: string | undefined, env: Readonly<NodeJS.ProcessEnv>): number {
  const value = raw ?? env.ROUTEKIT_DRAIN_GRACE;
  if (value === undefined || value.length === 0) return DEFAULT_DRAIN_GRACE_SECONDS * 1000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3_600) {
    throw new CliError({ message: "--drain-grace must be between 0 and 3600 seconds" });
  }
  return Math.round(seconds * 1000);
}
