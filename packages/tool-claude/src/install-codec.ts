import { createHash } from "node:crypto";

import { gatewayOrigin } from "@velum-labs/routekit-runtime";

export type ClaudeSettings = Record<string, unknown> & {
  env?: Record<string, unknown>;
};

export type FileSnapshot = {
  content: string | null;
  mode: number | null;
  hash: string | null;
};

export type InstalledManifest = {
  version: 2;
  state: "installed";
  ownerId: string;
  original: FileSnapshot;
  exactRestoreEligible: boolean;
  installedContentHash: string;
  managedEnvValues: Record<string, string>;
  /** `availableModels` entries contributed by RouteKit, never user entries. */
  managedPickerModels?: string[];
  /** True only when RouteKit created the `availableModels` array itself. */
  managedAvailableModels?: true;
  /** True only when RouteKit created this top-level policy setting. */
  managedEnforceAvailableModels?: true;
  /** Exact top-level apiKeyHelper string contributed by RouteKit. */
  managedApiKeyHelper?: string;
};

export type InstallPendingManifest = {
  version: 2;
  state: "install-pending";
  ownerId: string;
  beforeSettings: FileSnapshot;
  beforeManifest: InstalledManifest | null;
  targetSettings: FileSnapshot;
  targetManifest: InstalledManifest;
};

export type UninstallPendingManifest = {
  version: 2;
  state: "uninstall-pending";
  ownerId: string;
  beforeSettings: FileSnapshot;
  targetSettings: FileSnapshot;
};

export type ClaudeInstallManifest =
  | InstalledManifest
  | InstallPendingManifest
  | UninstallPendingManifest;

export const MANAGED_ENV_KEYS = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT"] as const;

const RETIRED_MANAGED_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"
] as const;

const CLAUDE_PICKER_PREFIX = "anthropic.routekit.";

export function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function snapshot(content: string | null, mode: number | null): FileSnapshot {
  return {
    content,
    mode,
    hash: content === null ? null : hash(content)
  };
}

export function parseSettings(content: string, configPath: string): ClaudeSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`your Claude settings (${configPath}) are not valid JSON (${detail})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`your Claude settings (${configPath}) must contain a JSON object`);
  }
  const settings = parsed as ClaudeSettings;
  if (
    settings.env !== undefined &&
    (typeof settings.env !== "object" || settings.env === null || Array.isArray(settings.env))
  ) {
    throw new Error(`the "env" field in your Claude settings (${configPath}) must be an object`);
  }
  return settings;
}

export function unsupportedManifest(manifestPath: string): Error {
  return new Error(
    `RouteKit's Claude ownership metadata (${manifestPath}) has an unsupported format`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is FileSnapshot {
  if (!isRecord(value)) return false;
  const validMode =
    value.mode === null ||
    (typeof value.mode === "number" &&
      Number.isInteger(value.mode) &&
      value.mode >= 0 &&
      value.mode <= 0o777);
  return (
    (typeof value.content === "string" || value.content === null) &&
    validMode &&
    (value.content !== null || value.mode === null) &&
    (typeof value.hash === "string" || value.hash === null) &&
    value.hash === (value.content === null ? null : hash(value.content))
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isInstalledManifest(value: unknown): value is InstalledManifest {
  return (
    isRecord(value) &&
    value.version === 2 &&
    value.state === "installed" &&
    typeof value.ownerId === "string" &&
    isSnapshot(value.original) &&
    typeof value.exactRestoreEligible === "boolean" &&
    typeof value.installedContentHash === "string" &&
    isStringRecord(value.managedEnvValues) &&
    (value.managedPickerModels === undefined || isStringArray(value.managedPickerModels)) &&
    (value.managedAvailableModels === undefined || value.managedAvailableModels === true) &&
    (value.managedEnforceAvailableModels === undefined ||
      value.managedEnforceAvailableModels === true) &&
    (value.managedApiKeyHelper === undefined || typeof value.managedApiKeyHelper === "string")
  );
}

export function parseManifest(content: string, manifestPath: string): ClaudeInstallManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      `RouteKit's Claude ownership metadata (${manifestPath}) is invalid; ` +
        "move it aside and restore settings.json before retrying"
    );
  }
  if (isInstalledManifest(parsed)) return parsed;
  if (
    isRecord(parsed) &&
    parsed.version === 2 &&
    parsed.state === "install-pending" &&
    typeof parsed.ownerId === "string" &&
    isSnapshot(parsed.beforeSettings) &&
    (parsed.beforeManifest === null || isInstalledManifest(parsed.beforeManifest)) &&
    isSnapshot(parsed.targetSettings) &&
    isInstalledManifest(parsed.targetManifest)
  ) {
    const pending = parsed as InstallPendingManifest;
    if (
      pending.targetManifest.ownerId !== pending.ownerId ||
      pending.targetManifest.installedContentHash !== pending.targetSettings.hash ||
      (pending.beforeManifest !== null && pending.beforeManifest.ownerId !== pending.ownerId)
    ) {
      throw unsupportedManifest(manifestPath);
    }
    return pending;
  }
  if (
    isRecord(parsed) &&
    parsed.version === 2 &&
    parsed.state === "uninstall-pending" &&
    typeof parsed.ownerId === "string" &&
    isSnapshot(parsed.beforeSettings) &&
    isSnapshot(parsed.targetSettings)
  ) {
    return parsed as UninstallPendingManifest;
  }
  throw unsupportedManifest(manifestPath);
}

export function managedEnv(input: { gatewayUrl: string }): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: gatewayOrigin(input.gatewayUrl),
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1"
  };
}

export function pickerModels(input: { models: readonly string[] }): string[] {
  const models = new Set<string>();
  for (const model of input.models) {
    if (typeof model !== "string" || model.length === 0) {
      throw new Error("RouteKit's Claude picker catalog contains an invalid model id");
    }
    models.add(`${CLAUDE_PICKER_PREFIX}${model}`);
  }
  return [...models];
}

export function availableModels(
  settings: ClaudeSettings,
  configPath: string
): string[] | undefined {
  if (settings.availableModels === undefined) return undefined;
  if (!isStringArray(settings.availableModels)) {
    throw new Error(
      `the "availableModels" field in your Claude settings (${configPath}) must be an array of strings`
    );
  }
  return [...settings.availableModels];
}

export function enforceAvailableModels(
  settings: ClaudeSettings,
  configPath: string
): boolean | undefined {
  if (settings.enforceAvailableModels === undefined) return undefined;
  if (typeof settings.enforceAvailableModels !== "boolean") {
    throw new Error(
      `the "enforceAvailableModels" field in your Claude settings (${configPath}) must be a boolean`
    );
  }
  return settings.enforceAvailableModels;
}

export function removableManagedKeys(
  env: Record<string, unknown>,
  managedEnvValues: Record<string, string | string[]>,
  configPath: string
): string[] {
  const removable: string[] = [];
  for (const [key, expected] of Object.entries(managedEnvValues)) {
    const accepted = Array.isArray(expected) ? expected : [expected];
    if (accepted.includes(String(env[key]))) {
      removable.push(key);
      continue;
    }
    if ((RETIRED_MANAGED_ENV_KEYS as readonly string[]).includes(key)) continue;
    throw new Error(
      `your Claude settings changed RouteKit-managed env.${key} in ${configPath}; ` +
        `remove or restore that value before rerunning the install command`
    );
  }
  return removable;
}
