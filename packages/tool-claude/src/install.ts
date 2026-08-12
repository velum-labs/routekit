import type { Stats } from "node:fs";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SUBSCRIPTIONS } from "@velum-labs/routekit-registry";
import { acquireLifecycleLock, writeFileAtomic } from "@velum-labs/routekit-runtime";

import {
  availableModels,
  type ClaudeInstallManifest,
  type ClaudeSettings,
  enforceAvailableModels,
  type FileSnapshot,
  type InstalledManifest,
  type InstallPendingManifest,
  MANAGED_ENV_KEYS,
  managedEnv,
  parseManifest,
  parseSettings,
  pickerModels,
  removableManagedKeys,
  serialize,
  snapshot,
  type UninstallPendingManifest,
  unsupportedManifest
} from "./install-codec.js";

export type ClaudeInstallOwner = {
  id: string;
  displayName: string;
  installCommand: string;
  uninstallCommand: string;
  startCommand: string;
};

export type ClaudeInstallInput = {
  gatewayUrl: string;
  /** Canonical RouteKit catalog ids permitted by the current model policy. */
  models: readonly string[];
  /**
   * Command Claude Code invokes when it needs the gateway bearer token. The
   * helper output is never persisted in settings.json.
   */
  apiKeyHelper?: string;
  owner: ClaudeInstallOwner;
  claudeConfigDir?: string;
};

export type ClaudeInstallResult = {
  configPath: string;
  action: "installed" | "updated";
  managedKeys: string[];
};

type ClaudeInstallWriteBoundary =
  | "install-pending"
  | "install-settings"
  | "install-committed"
  | "uninstall-pending"
  | "uninstall-settings"
  | "uninstall-committed";

function reached(boundary: ClaudeInstallWriteBoundary): void {
  // Deliberately not part of the package API: tests install a same-process
  // throw hook to model termination immediately after an atomic boundary.
  const testingGlobal = globalThis as typeof globalThis & {
    __routekitClaudeInstallFaultInjector?: (reached: ClaudeInstallWriteBoundary) => void;
  };
  testingGlobal.__routekitClaudeInstallFaultInjector?.(boundary);
}

function assertSafeOwnerId(ownerId: string): void {
  if (
    ownerId.length === 0 ||
    ownerId.includes("/") ||
    ownerId.includes("\\") ||
    ownerId === "." ||
    ownerId === ".."
  ) {
    throw new Error(`Claude integration owner id is not path-safe: ${JSON.stringify(ownerId)}`);
  }
}

function defaultClaudeConfigDir(): string {
  const registryPath = SUBSCRIPTIONS["claude-code"].configPath ?? "~/.claude/settings.json";
  const configPath = registryPath.startsWith("~/")
    ? join(homedir(), registryPath.slice(2))
    : registryPath;
  return dirname(configPath);
}

export function claudeIntegrationConfigPath(claudeConfigDir?: string): string {
  return join(
    claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? defaultClaudeConfigDir(),
    "settings.json"
  );
}

function paths(input: { ownerId: string; claudeConfigDir?: string }): {
  configDirectory: string;
  configPath: string;
  manifestPath: string;
  lockPath: string;
} {
  assertSafeOwnerId(input.ownerId);
  const configPath = claudeIntegrationConfigPath(input.claudeConfigDir);
  const configDirectory = dirname(configPath);
  return {
    configDirectory,
    configPath,
    manifestPath: join(configDirectory, `.${input.ownerId}-integration.json`),
    lockPath: join(configDirectory, ".routekit-claude-integration.lock")
  };
}

function entryIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertConfigDirectory(configDirectory: string): void {
  const entry = entryIfExists(configDirectory);
  if (entry === undefined) return;
  if (entry.isSymbolicLink()) {
    throw new Error(`Claude config directory must not be a symlink: ${configDirectory}`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`Claude config path is not a directory: ${configDirectory}`);
  }
}

function ensureConfigDirectory(configDirectory: string): void {
  assertConfigDirectory(configDirectory);
  if (entryIfExists(configDirectory) !== undefined) return;
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  assertConfigDirectory(configDirectory);
  chmodSync(configDirectory, 0o700);
}

function assertRegularFileIfExists(path: string, label: string): void {
  const entry = entryIfExists(path);
  if (entry === undefined) return;
  if (entry.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${path}`);
  }
  if (!entry.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
}

function readSnapshot(path: string, label: string): FileSnapshot {
  assertRegularFileIfExists(path, label);
  const entry = entryIfExists(path);
  if (entry === undefined) return snapshot(null, null);
  return snapshot(readFileSync(path, "utf8"), entry.mode & 0o777);
}

function writePrivateFile(path: string, content: string, label: string): void {
  assertRegularFileIfExists(path, label);
  writeFileAtomic(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function applySnapshot(path: string, target: FileSnapshot, label: string): void {
  assertRegularFileIfExists(path, label);
  if (target.content === null) {
    rmSync(path, { force: true });
    return;
  }
  const mode = target.mode ?? 0o600;
  writeFileAtomic(path, target.content, { mode });
  chmodSync(path, mode);
}

function writeManifest(manifestPath: string, manifest: ClaudeInstallManifest): void {
  writePrivateFile(manifestPath, serialize(manifest), "Claude ownership metadata");
}

function currentManifest(manifestPath: string): ClaudeInstallManifest | undefined {
  assertRegularFileIfExists(manifestPath, "Claude ownership metadata");
  return entryIfExists(manifestPath) === undefined
    ? undefined
    : parseManifest(readFileSync(manifestPath, "utf8"), manifestPath);
}

function assertExpectedSnapshot(
  current: FileSnapshot,
  expected: readonly FileSnapshot[],
  configPath: string,
  operation: string
): void {
  if (expected.some((candidate) => candidate.hash === current.hash)) return;
  throw new Error(
    `your Claude settings changed unexpectedly during ${operation} recovery (${configPath}); ` +
      "RouteKit refused to overwrite the external edit"
  );
}

function recoverPending(
  manifest: InstallPendingManifest | UninstallPendingManifest,
  configPath: string,
  manifestPath: string
): void {
  const current = readSnapshot(configPath, "Claude settings");
  if (manifest.state === "install-pending") {
    assertExpectedSnapshot(
      current,
      [manifest.beforeSettings, manifest.targetSettings],
      configPath,
      "install"
    );
    if (current.hash !== manifest.beforeSettings.hash) {
      applySnapshot(configPath, manifest.beforeSettings, "Claude settings");
    } else if (
      current.content !== null &&
      manifest.beforeSettings.mode !== null &&
      current.mode !== manifest.beforeSettings.mode
    ) {
      chmodSync(configPath, manifest.beforeSettings.mode);
    }
    if (manifest.beforeManifest === null) {
      assertRegularFileIfExists(manifestPath, "Claude ownership metadata");
      rmSync(manifestPath, { force: true });
    } else {
      writeManifest(manifestPath, manifest.beforeManifest);
    }
    return;
  }

  assertExpectedSnapshot(
    current,
    [manifest.beforeSettings, manifest.targetSettings],
    configPath,
    "uninstall"
  );
  if (current.hash !== manifest.targetSettings.hash) {
    applySnapshot(configPath, manifest.targetSettings, "Claude settings");
  } else if (
    current.content !== null &&
    manifest.targetSettings.mode !== null &&
    current.mode !== manifest.targetSettings.mode
  ) {
    chmodSync(configPath, manifest.targetSettings.mode);
  }
  assertRegularFileIfExists(manifestPath, "Claude ownership metadata");
  rmSync(manifestPath, { force: true });
}

const CLAUDE_LOCK_TIMEOUT_MS = 5_000;

async function withConfigLock<T>(
  resolved: ReturnType<typeof paths>,
  operation: () => T | Promise<T>
): Promise<T> {
  ensureConfigDirectory(resolved.configDirectory);
  assertRegularFileIfExists(resolved.lockPath, "Claude integration lock");
  assertRegularFileIfExists(`${resolved.lockPath}.reap`, "Claude integration reaper lock");
  const lock = await acquireLifecycleLock(resolved.lockPath, {
    timeoutMs: CLAUDE_LOCK_TIMEOUT_MS,
    pollMs: 50
  });
  try {
    assertConfigDirectory(resolved.configDirectory);
    assertRegularFileIfExists(resolved.lockPath, "Claude integration lock");
    return await operation();
  } finally {
    lock.release();
  }
}

export async function installClaudeIntegration(
  input: ClaudeInstallInput
): Promise<ClaudeInstallResult> {
  const resolved = paths({
    ownerId: input.owner.id,
    ...(input.claudeConfigDir !== undefined ? { claudeConfigDir: input.claudeConfigDir } : {})
  });
  return await withConfigLock(resolved, () => {
    const { configPath, manifestPath } = resolved;
    let manifest = currentManifest(manifestPath);
    if (manifest !== undefined && manifest.ownerId !== input.owner.id) {
      throw new Error(
        `Claude ownership metadata in ${manifestPath} belongs to another integration`
      );
    }
    if (manifest?.version === 2 && manifest.state !== "installed") {
      recoverPending(manifest, configPath, manifestPath);
      manifest = currentManifest(manifestPath);
    }

    const beforeSettings = readSnapshot(configPath, "Claude settings");
    let previousManifest: InstalledManifest | undefined;
    if (manifest?.state === "installed") {
      previousManifest = manifest;
    } else if (manifest !== undefined) {
      throw unsupportedManifest(manifestPath);
    }
    const settings = parseSettings(beforeSettings.content ?? "{}\n", configPath);
    const env = { ...(settings.env ?? {}) };
    const nextManaged = managedEnv(input);
    if (settings.apiKeyHelper !== undefined && typeof settings.apiKeyHelper !== "string") {
      throw new Error(
        `the "apiKeyHelper" field in your Claude settings (${configPath}) must be a string`
      );
    }
    const currentApiKeyHelper = settings.apiKeyHelper as string | undefined;
    const previousApiKeyHelper = previousManifest?.managedApiKeyHelper;
    if (previousApiKeyHelper !== undefined && currentApiKeyHelper !== previousApiKeyHelper) {
      throw new Error(
        `your Claude settings changed RouteKit-managed apiKeyHelper in ${configPath}; ` +
          "restore that value before rerunning the install command"
      );
    }
    if (
      previousManifest === undefined &&
      input.apiKeyHelper !== undefined &&
      currentApiKeyHelper !== undefined
    ) {
      throw new Error(
        `your Claude settings already define apiKeyHelper in ${configPath}; ` +
          `remove it before rerunning \`${input.owner.installCommand}\``
      );
    }
    const desiredPickerModels = pickerModels(input);
    if (desiredPickerModels.length === 0) {
      throw new Error("RouteKit's Claude picker catalog cannot be empty");
    }

    if (previousManifest === undefined) {
      for (const key of MANAGED_ENV_KEYS) {
        if (env[key] !== undefined) {
          throw new Error(
            `your Claude settings already define env.${key} in ${configPath}; ` +
              `remove it or use \`${input.owner.uninstallCommand}\` only after configuring RouteKit`
          );
        }
      }
    }

    const removableKeys =
      previousManifest === undefined
        ? []
        : removableManagedKeys(env, previousManifest.managedEnvValues, configPath);
    for (const key of removableKeys) delete env[key];
    Object.assign(env, nextManaged);
    const currentPickerModels = availableModels(settings, configPath);
    const priorManagedPickerModels = previousManifest?.managedPickerModels ?? [];
    if (
      priorManagedPickerModels.some(
        (model) => currentPickerModels === undefined || !currentPickerModels.includes(model)
      )
    ) {
      throw new Error(
        `your Claude settings changed RouteKit-managed availableModels in ${configPath}; ` +
          `restore those entries before rerunning the install command`
      );
    }
    const userPickerModels = (currentPickerModels ?? []).filter(
      (model) => !priorManagedPickerModels.includes(model)
    );
    const nextManagedPickerModels = desiredPickerModels.filter(
      (model) => !userPickerModels.includes(model)
    );
    const nextPickerModels = [...userPickerModels, ...nextManagedPickerModels];

    const currentEnforceAvailableModels = enforceAvailableModels(settings, configPath);
    if (
      previousManifest?.managedEnforceAvailableModels === true &&
      currentEnforceAvailableModels !== true
    ) {
      throw new Error(
        `your Claude settings changed RouteKit-managed enforceAvailableModels in ${configPath}; ` +
          "restore that value before rerunning the install command"
      );
    }
    const nextManagedEnforceAvailableModels =
      previousManifest?.managedEnforceAvailableModels === true ||
      currentEnforceAvailableModels === undefined
        ? true
        : undefined;
    const nextSettings: ClaudeSettings = {
      ...settings,
      env,
      availableModels: nextPickerModels,
      ...(input.apiKeyHelper !== undefined ? { apiKeyHelper: input.apiKeyHelper } : {}),
      ...(nextManagedEnforceAvailableModels === true ? { enforceAvailableModels: true } : {})
    };
    if (input.apiKeyHelper === undefined && previousApiKeyHelper !== undefined) {
      delete nextSettings.apiKeyHelper;
    }
    const nextContent = serialize(nextSettings);
    const targetSettings = snapshot(nextContent, 0o600);
    const exactRestoreEligible =
      previousManifest === undefined
        ? true
        : previousManifest.exactRestoreEligible &&
          beforeSettings.hash === previousManifest.installedContentHash;
    const targetManifest: InstalledManifest = {
      version: 2,
      state: "installed",
      ownerId: input.owner.id,
      original: previousManifest?.original ?? beforeSettings,
      exactRestoreEligible,
      installedContentHash: targetSettings.hash as string,
      managedEnvValues: nextManaged,
      managedPickerModels: nextManagedPickerModels,
      ...(previousManifest?.managedAvailableModels === true || currentPickerModels === undefined
        ? { managedAvailableModels: true as const }
        : {}),
      ...(nextManagedEnforceAvailableModels === true
        ? { managedEnforceAvailableModels: true as const }
        : {}),
      ...(input.apiKeyHelper !== undefined ? { managedApiKeyHelper: input.apiKeyHelper } : {})
    };
    const pendingManifest: InstallPendingManifest = {
      version: 2,
      state: "install-pending",
      ownerId: input.owner.id,
      beforeSettings,
      beforeManifest: previousManifest ?? null,
      targetSettings,
      targetManifest
    };

    writeManifest(manifestPath, pendingManifest);
    reached("install-pending");
    const unchanged = readSnapshot(configPath, "Claude settings");
    assertExpectedSnapshot(unchanged, [beforeSettings], configPath, "install");
    applySnapshot(configPath, targetSettings, "Claude settings");
    reached("install-settings");
    const pending = currentManifest(manifestPath);
    if (pending?.version !== 2 || pending.state !== "install-pending") {
      throw new Error(
        `Claude ownership metadata changed unexpectedly during install (${manifestPath})`
      );
    }
    writeManifest(manifestPath, targetManifest);
    reached("install-committed");
    return {
      configPath,
      action: previousManifest === undefined ? "installed" : "updated",
      managedKeys: [
        ...Object.keys(nextManaged),
        ...(input.apiKeyHelper !== undefined ? ["apiKeyHelper"] : []),
        "availableModels",
        ...(nextManagedEnforceAvailableModels === true ? ["enforceAvailableModels"] : [])
      ]
    };
  });
}

export async function uninstallClaudeIntegration(input: {
  ownerId: string;
  claudeConfigDir?: string;
}): Promise<{ configPath: string; removed: boolean }> {
  const resolved = paths(input);
  return await withConfigLock(resolved, () => {
    const { configPath, manifestPath } = resolved;
    let manifest = currentManifest(manifestPath);
    if (manifest === undefined) return { configPath, removed: false };
    if (manifest.ownerId !== input.ownerId) {
      throw new Error(
        `Claude ownership metadata in ${manifestPath} belongs to another integration`
      );
    }
    if (manifest.version === 2 && manifest.state !== "installed") {
      recoverPending(manifest, configPath, manifestPath);
      if (manifest.state === "uninstall-pending") {
        reached("uninstall-committed");
        return { configPath, removed: true };
      }
      manifest = currentManifest(manifestPath);
      if (manifest === undefined) return { configPath, removed: false };
    }

    const beforeSettings = readSnapshot(configPath, "Claude settings");
    let installed: InstalledManifest | undefined;
    if (manifest.state === "installed") {
      installed = manifest;
    } else {
      throw unsupportedManifest(manifestPath);
    }
    if (installed === undefined) return { configPath, removed: false };
    let targetSettings: FileSnapshot;
    if (installed.exactRestoreEligible && beforeSettings.hash === installed.installedContentHash) {
      targetSettings = installed.original;
    } else if (beforeSettings.content !== null) {
      const settings = parseSettings(beforeSettings.content, configPath);
      const env = { ...(settings.env ?? {}) };
      for (const [key, accepted] of Object.entries(installed.managedEnvValues)) {
        if (String(env[key]) === accepted) delete env[key];
      }
      const next: ClaudeSettings = { ...settings };
      if (
        installed.managedApiKeyHelper !== undefined &&
        settings.apiKeyHelper === installed.managedApiKeyHelper
      ) {
        delete next.apiKeyHelper;
      }
      if (Object.keys(env).length === 0) delete next.env;
      else next.env = env;
      const currentPickerModels = availableModels(settings, configPath);
      if (currentPickerModels !== undefined) {
        const remainingPickerModels = currentPickerModels.filter(
          (model) => !(installed.managedPickerModels ?? []).includes(model)
        );
        if (installed.managedAvailableModels === true && remainingPickerModels.length === 0) {
          delete next.availableModels;
        } else {
          next.availableModels = remainingPickerModels;
        }
      }
      const currentEnforceAvailableModels = enforceAvailableModels(settings, configPath);
      if (
        installed.managedEnforceAvailableModels === true &&
        currentEnforceAvailableModels === true
      ) {
        delete next.enforceAvailableModels;
      }
      targetSettings = snapshot(serialize(next), beforeSettings.mode);
    } else {
      targetSettings = beforeSettings;
    }

    const pendingManifest: UninstallPendingManifest = {
      version: 2,
      state: "uninstall-pending",
      ownerId: input.ownerId,
      beforeSettings,
      targetSettings
    };
    writeManifest(manifestPath, pendingManifest);
    reached("uninstall-pending");
    const unchanged = readSnapshot(configPath, "Claude settings");
    assertExpectedSnapshot(unchanged, [beforeSettings], configPath, "uninstall");
    applySnapshot(configPath, targetSettings, "Claude settings");
    reached("uninstall-settings");
    const pending = currentManifest(manifestPath);
    if (pending?.version !== 2 || pending.state !== "uninstall-pending") {
      throw new Error(
        `Claude ownership metadata changed unexpectedly during uninstall (${manifestPath})`
      );
    }
    rmSync(manifestPath, { force: true });
    reached("uninstall-committed");
    return { configPath, removed: true };
  });
}
