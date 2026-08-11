import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { acquireLifecycleLock, writeFileAtomic } from "@velum-labs/routekit-runtime";

import { routekitHome } from "./config.js";
import { routekitVersion } from "./state.js";

export type NativeIntegrationTool = "claude" | "codex";
export type NativeIntegrationTarget = { kind: "local" } | { kind: "remote"; name: string };

export type NativeIntegration = {
  /** Version of RouteKit's install contract for this native client. */
  installVersion: 1;
  /** RouteKit package version that most recently installed it. */
  managedByVersion: string;
  tool: NativeIntegrationTool;
  configPath: string;
  target: NativeIntegrationTarget;
  tokenId: string;
  tokenRevoked?: true;
};
export type NativeIntegrationRegistryOptions = { routekitHome?: string };

type NativeIntegrationInput = Omit<NativeIntegration, "installVersion" | "managedByVersion">;
type NativeIntegrationRegistry = { version: 1; integrations: NativeIntegration[] };
const NATIVE_INTEGRATION_INSTALL_VERSION = 1;
const PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function nativeIntegrationsPath(options: NativeIntegrationRegistryOptions = {}): string {
  return join(options.routekitHome ?? routekitHome(), "integrations", "native-clients.json");
}

function lockPath(options: NativeIntegrationRegistryOptions = {}): string {
  return join(options.routekitHome ?? routekitHome(), "integrations", "native-clients.lock");
}

function keyOf(tool: NativeIntegrationTool, configPath: string): string {
  return `${tool}\u0000${resolve(configPath)}`;
}

function parseTarget(value: unknown): NativeIntegrationTarget | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const target = value as Record<string, unknown>;
  if (target.kind === "local" && Object.keys(target).length === 1) return { kind: "local" };
  if (
    target.kind === "remote" &&
    typeof target.name === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(target.name) &&
    Object.keys(target).length === 2
  ) {
    return { kind: "remote", name: target.name };
  }
  return undefined;
}

function parseIntegration(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`native client integration registry is corrupt: ${nativeIntegrationsPath()}`);
  }
  return value as Record<string, unknown>;
}

function parseRegistry(
  value: unknown,
  options: NativeIntegrationRegistryOptions = {}
): NativeIntegrationRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `native client integration registry is corrupt: ${nativeIntegrationsPath(options)}`
    );
  }
  const registry = value as Record<string, unknown>;
  if (registry.version !== 1 || !Array.isArray(registry.integrations)) {
    throw new Error(
      `unsupported native client integration registry: ${nativeIntegrationsPath(options)}`
    );
  }
  const integrations = registry.integrations.map((value): NativeIntegration => {
    const entry = parseIntegration(value);
    const target = parseTarget(entry.target);
    if (
      entry.installVersion !== NATIVE_INTEGRATION_INSTALL_VERSION ||
      typeof entry.managedByVersion !== "string" ||
      !PACKAGE_VERSION_PATTERN.test(entry.managedByVersion) ||
      (entry.tool !== "claude" && entry.tool !== "codex") ||
      typeof entry.configPath !== "string" ||
      !isAbsolute(entry.configPath) ||
      typeof entry.tokenId !== "string" ||
      !/^[a-f0-9]{16}$/i.test(entry.tokenId) ||
      target === undefined ||
      (entry.tokenRevoked !== undefined && entry.tokenRevoked !== true) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "installVersion",
            "managedByVersion",
            "tool",
            "configPath",
            "target",
            "tokenId",
            "tokenRevoked"
          ].includes(key)
      )
    ) {
      throw new Error(
        `native client integration registry is corrupt: ${nativeIntegrationsPath(options)}`
      );
    }
    return {
      installVersion: 1,
      managedByVersion: entry.managedByVersion,
      tool: entry.tool,
      configPath: resolve(entry.configPath),
      target,
      tokenId: entry.tokenId,
      ...(entry.tokenRevoked === true ? { tokenRevoked: true } : {})
    };
  });
  if (
    new Set(integrations.map((entry) => keyOf(entry.tool, entry.configPath))).size !==
    integrations.length
  ) {
    throw new Error(
      `native client integration registry contains duplicate entries: ${nativeIntegrationsPath(options)}`
    );
  }
  return { version: 1, integrations };
}

function readRegistry(options: NativeIntegrationRegistryOptions = {}): NativeIntegrationRegistry {
  const path = nativeIntegrationsPath(options);
  if (!existsSync(path)) return { version: 1, integrations: [] };
  try {
    return parseRegistry(JSON.parse(readFileSync(path, "utf8")) as unknown, options);
  } catch (error) {
    if (error instanceof Error && error.message.includes("native client integration registry")) {
      throw error;
    }
    throw new Error(`native client integration registry is not valid JSON: ${path}`);
  }
}

function writeRegistry(
  registry: NativeIntegrationRegistry,
  options: NativeIntegrationRegistryOptions = {}
): void {
  const parsed = parseRegistry(registry, options);
  parsed.integrations.sort((left, right) =>
    keyOf(left.tool, left.configPath).localeCompare(keyOf(right.tool, right.configPath))
  );
  const path = nativeIntegrationsPath(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function mutate<T>(
  operation: (registry: NativeIntegrationRegistry) => {
    registry: NativeIntegrationRegistry;
    result: T;
  },
  options: NativeIntegrationRegistryOptions = {}
): Promise<T> {
  mkdirSync(dirname(nativeIntegrationsPath(options)), { recursive: true, mode: 0o700 });
  const lock = await acquireLifecycleLock(lockPath(options));
  try {
    const result = operation(readRegistry(options));
    writeRegistry(result.registry, options);
    return result.result;
  } finally {
    lock.release();
  }
}

export function getNativeIntegration(
  tool: NativeIntegrationTool,
  configPath: string,
  options: NativeIntegrationRegistryOptions = {}
): NativeIntegration | undefined {
  return readRegistry(options).integrations.find(
    (entry) => keyOf(entry.tool, entry.configPath) === keyOf(tool, configPath)
  );
}

export function listNativeIntegrations(
  options: NativeIntegrationRegistryOptions = {}
): NativeIntegration[] {
  return readRegistry(options).integrations;
}

export async function putNativeIntegration(entry: NativeIntegrationInput): Promise<void> {
  const normalized: NativeIntegration = {
    ...entry,
    installVersion: NATIVE_INTEGRATION_INSTALL_VERSION,
    managedByVersion: routekitVersion(),
    configPath: resolve(entry.configPath)
  };
  await mutate((registry) => ({
    registry: {
      version: 1,
      integrations: [
        ...registry.integrations.filter(
          (current) =>
            keyOf(current.tool, current.configPath) !==
            keyOf(normalized.tool, normalized.configPath)
        ),
        normalized
      ]
    },
    result: undefined
  }));
}

export async function markNativeIntegrationTokenRevoked(
  tool: NativeIntegrationTool,
  configPath: string
): Promise<void> {
  await mutate((registry) => ({
    registry: {
      version: 1,
      integrations: registry.integrations.map((entry) =>
        keyOf(entry.tool, entry.configPath) === keyOf(tool, configPath)
          ? { ...entry, tokenRevoked: true }
          : entry
      )
    },
    result: undefined
  }));
}

export async function deleteNativeIntegration(
  tool: NativeIntegrationTool,
  configPath: string
): Promise<void> {
  await mutate((registry) => ({
    registry: {
      version: 1,
      integrations: registry.integrations.filter(
        (entry) => keyOf(entry.tool, entry.configPath) !== keyOf(tool, configPath)
      )
    },
    result: undefined
  }));
}
