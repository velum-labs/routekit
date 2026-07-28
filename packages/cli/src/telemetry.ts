import { CLI_COMMAND_TELEMETRY_FIELDS } from "@velum-labs/routekit-telemetry-core";

/** @deprecated Event helpers remain shared; consent is daemon-owned. */
export const TELEMETRY_FIELDS = {
  "cli.command": CLI_COMMAND_TELEMETRY_FIELDS
} as const;
