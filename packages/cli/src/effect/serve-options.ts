import { CliError } from "@velum-labs/routekit-cli-core";
import { Option } from "effect";
import { Flag } from "effect/unstable/cli";

const optionalString = (name: string) =>
  Flag.string(name).pipe(Flag.optional, Flag.map(Option.getOrUndefined));

export const gatewayServeFlags = {
  host: Flag.string("host").pipe(Flag.withDefault("127.0.0.1"), Flag.withDescription("bind host")),
  port: Flag.string("port").pipe(Flag.withDefault("8080"), Flag.withDescription("bind port")),
  authToken: optionalString("auth-token").pipe(
    Flag.withDescription("authentication token (required for non-loopback hosts)")
  ),
  portless: Flag.boolean("no-portless").pipe(
    Flag.map((disabled) => !disabled),
    Flag.withDescription("disable the stable local route")
  ),
  drainGrace: optionalString("drain-grace").pipe(
    Flag.withDescription(
      "grace for in-flight requests on shutdown/upgrade (default: $ROUTEKIT_DRAIN_GRACE or 30)"
    )
  )
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
