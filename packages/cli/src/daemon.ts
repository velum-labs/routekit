/**
 * RouteKit bindings for the shared service core in `@velum-labs/routekit-runtime`: the
 * daemon supervisor unit spec (what `routekit start` and `daemon service
 * install` write) and the secrets environment file the systemd unit
 * references.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { CLIPROXY_API_KEY_ENV, cliproxyApiKey } from "@velum-labs/routekit-accounts";
import { CliError } from "@velum-labs/routekit-cli-core";
import { configuredProviderIds } from "@velum-labs/routekit-config";
import type { ApiProviderId, RouterConfig } from "@velum-labs/routekit-gateway";
import { API_PROVIDER_IDS } from "@velum-labs/routekit-gateway";
import { PROVIDERS, SUBSCRIPTIONS } from "@velum-labs/routekit-registry";
import type { ServiceUnitSpec } from "@velum-labs/routekit-runtime";
import {
  launchdPlistPath,
  SERVICE_UNSET_ENV,
  serviceLogPath,
  writeFileAtomic
} from "@velum-labs/routekit-runtime";

import { routekitHome } from "./config.js";

export const ROUTEKIT_PRODUCT = "routekit";

const AWS_BEDROCK_PROVIDER = "bedrock";
const AWS_CONTAINER_AUTHORIZATION_TOKEN_ENV = "AWS_CONTAINER_AUTHORIZATION_TOKEN";

/**
 * AWS SDK default credential-chain inputs that a supervised daemon cannot
 * otherwise inherit from the interactive shell. The direct container
 * authorization-token value is not copied: container and web-identity
 * credentials are referenced by URI or file so the SDK can obtain/refresh
 * them at runtime.
 */
const AWS_BEDROCK_SERVICE_ENV_NAMES = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_SDK_LOAD_CONFIG",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_STS_REGIONAL_ENDPOINTS"
] as const;

/**
 * The entry script the current invocation runs from. For a global install
 * this is the stable `routekit` bin shim, so units written with it pick up
 * upgraded code without being rewritten.
 */
export function cliEntryPath(): string {
  const entry = process.argv[1];
  if (entry === undefined) {
    throw new CliError({ message: "cannot resolve the routekit entry script" });
  }
  return entry;
}

/**
 * Environment the service process needs but a supervisor-started process
 * would not inherit from the user's shell: provider credentials and base-URL
 * overrides for the configured providers, plus RouteKit's own knobs.
 */
export type ServiceEnvironment = {
  set: Record<string, string>;
  unset: string[];
};

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function subscriptionEnvironmentNames(provider: "codex" | "claude-code"): string[] {
  return Object.values(SUBSCRIPTIONS[provider].overrideEnv ?? {}).flatMap((names) => [...names]);
}

/** Build the explicit environment contract for a supervised RouteKit daemon. */
export function serviceEnvironment(
  config: RouterConfig,
  sourceEnv: NodeJS.ProcessEnv = process.env
): ServiceEnvironment {
  const set: Record<string, string> = {};
  const unset = new Set<string>();
  const passthrough = [
    "ROUTEKIT_HOME",
    "ROUTEKIT_PORTLESS",
    "ROUTEKIT_DRAIN_GRACE",
    "ROUTEKIT_TELEMETRY",
    "ROUTEKIT_POSTHOG_KEY",
    "ROUTEKIT_POSTHOG_HOST",
    "DO_NOT_TRACK",
    "PORTLESS_STATE_DIR",
    "PORTLESS_TLD"
  ];
  for (const name of passthrough) {
    const value = sourceEnv[name];
    if (value !== undefined) set[name] = value;
  }

  for (const provider of configuredProviderIds(config)) {
    if (provider === AWS_BEDROCK_PROVIDER) {
      for (const name of AWS_BEDROCK_SERVICE_ENV_NAMES) {
        const value = sourceEnv[name];
        if (value === undefined) unset.add(name);
        else set[name] = value;
      }
      unset.add(AWS_CONTAINER_AUTHORIZATION_TOKEN_ENV);
      continue;
    }

    if (provider === "codex" || provider === "claude-code") {
      for (const name of subscriptionEnvironmentNames(provider)) unset.add(name);
      continue;
    }

    if (!API_PROVIDER_IDS.includes(provider as ApiProviderId)) continue;
    const info = PROVIDERS[provider];
    if (info === undefined) continue;

    if (info.keyEnv !== undefined) {
      const explicit = nonEmpty(sourceEnv[info.keyEnv]);
      const credential =
        provider === "cliproxy" && explicit === undefined ? cliproxyApiKey(sourceEnv) : explicit;
      if (credential !== undefined) set[info.keyEnv] = credential;
      else unset.add(info.keyEnv);
    }
    if (info.authTokenEnv !== undefined) unset.add(info.authTokenEnv);
    for (const name of info.credentialEnvNames ?? []) unset.add(name);
    if (info.baseUrlEnv !== undefined) {
      const baseUrl = nonEmpty(sourceEnv[info.baseUrlEnv]) ?? info.baseUrl;
      if (baseUrl !== undefined) set[info.baseUrlEnv] = baseUrl;
      else unset.add(info.baseUrlEnv);
    }
  }

  for (const name of Object.keys(set)) unset.delete(name);
  return { set, unset: [...unset].sort() };
}

export function missingServiceCredentialVariables(
  config: RouterConfig,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const missing = new Set<string>();
  for (const provider of configuredProviderIds(config)) {
    // Bedrock authenticates through the AWS SDK default chain. It may use a
    // profile, SSO cache, role, web identity, container credentials, instance
    // metadata, or static environment credentials, so no single key variable
    // is mandatory here. The SDK reports a precise chain error at startup.
    if (provider === AWS_BEDROCK_PROVIDER) continue;
    if (provider === "codex" || provider === "claude-code") continue;
    if (!API_PROVIDER_IDS.includes(provider as ApiProviderId)) continue;
    const info = PROVIDERS[provider];
    if (info === undefined) continue;
    const keyEnv = info.keyEnv;
    if (keyEnv === undefined) continue;
    if (nonEmpty(env[keyEnv]) !== undefined) continue;
    if (keyEnv === CLIPROXY_API_KEY_ENV && cliproxyApiKey(env) !== undefined) continue;
    missing.add(keyEnv);
  }
  return [...missing];
}

export function serviceEnvFilePath(kind: string): string {
  return join(routekitHome(), "env", `${kind}.env`);
}

function quoteEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Write the 0600 secrets file a systemd unit references via EnvironmentFile. */
export function writeServiceEnvFile(kind: string, env: Record<string, string>): string {
  const path = serviceEnvFilePath(kind);
  const directory = join(routekitHome(), "env");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const lines = Object.entries(env).map(([name, value]) => `${name}=${quoteEnvValue(value)}`);
  writeFileAtomic(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function removeServiceEnvFile(kind: string): void {
  rmSync(serviceEnvFilePath(kind), { force: true });
}

export function serviceEnvironmentContractInstalled(supervisor: "systemd" | "launchd"): boolean {
  const path =
    supervisor === "systemd"
      ? serviceEnvFilePath("daemon")
      : launchdPlistPath(ROUTEKIT_PRODUCT, "daemon");
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf8").includes(SERVICE_UNSET_ENV);
  } catch {
    return false;
  }
}

export function daemonUnitSpec(input: {
  args: readonly string[];
  supervisor: "systemd" | "launchd";
  env: ServiceEnvironment;
  drainGraceMs: number;
  cwd?: string;
}): ServiceUnitSpec {
  const shared = {
    product: ROUTEKIT_PRODUCT,
    kind: "daemon",
    description: "RouteKit singleton daemon",
    command: {
      execPath: process.execPath,
      args: [cliEntryPath(), ...input.args]
    },
    // Persistent services must not depend on the directory from which the
    // install command happened to be run. That project may later be moved or
    // deleted, preventing launchd/systemd from starting the daemon.
    workingDirectory: input.cwd ?? routekitHome(),
    drainGraceMs: input.drainGraceMs
  };
  const env = {
    ...input.env.set,
    [SERVICE_UNSET_ENV]: JSON.stringify(input.env.unset)
  };
  if (input.supervisor === "systemd") {
    return {
      ...shared,
      environmentFile: writeServiceEnvFile("daemon", env)
    };
  }
  return {
    ...shared,
    env,
    logFile: serviceLogPath(routekitHome(), "daemon")
  };
}
