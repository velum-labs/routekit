import type { TelemetryEnvKind } from "./telemetry-event.ts";

const TELEMETRY_ENV_KIND = "ORI_TELEMETRY_ENV_KIND";
const CI_ENVIRONMENT_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "JENKINS_URL",
  "TF_BUILD",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
] as const;

const isTruthySignal = (value: string | undefined): boolean =>
  value !== undefined &&
  value.trim().length > 0 &&
  value !== "0" &&
  value.toLowerCase() !== "false";

const isCiEnvironment = (env: Record<string, string | undefined>): boolean =>
  CI_ENVIRONMENT_KEYS.some((key) => isTruthySignal(env[key]));

const isTelemetryEnvKind = (
  value: string | undefined
): value is TelemetryEnvKind =>
  value === "user" || value === "ci" || value === "dev";

export const detectTelemetryEnvKind = (input: {
  readonly env: Record<string, string | undefined>;
  readonly isReleasedBuild: boolean;
  readonly cliVersion: string;
}): TelemetryEnvKind => {
  if (isTelemetryEnvKind(input.env[TELEMETRY_ENV_KIND])) {
    return input.env[TELEMETRY_ENV_KIND];
  }
  if (isCiEnvironment(input.env)) {
    return "ci";
  }
  return input.isReleasedBuild && input.cliVersion !== "0.0.0" ? "user" : "dev";
};

export { TELEMETRY_ENV_KIND };
