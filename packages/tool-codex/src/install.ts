import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";

import type { ModelReasoningCapabilities } from "@velum-labs/routekit-contracts";
import { SUBSCRIPTIONS } from "@velum-labs/routekit-registry";
import { gatewayOpenAiBaseUrl } from "@velum-labs/routekit-runtime";

import {
  codexPersistentModelCatalogJson,
  codexProfileFileToml,
  readCodexHomeModelsCache
} from "./launch.js";

export type CodexInstallProfile = {
  modelId: string;
  /**
   * Legacy selector for the one persistent profile. New callers should use
   * `CodexInstallInput.profileId`; when both are absent it is `routekit`.
   */
  profileId?: string;
  description?: string;
  reasoning?: ModelReasoningCapabilities;
};

export type CodexInstallOwner = {
  id: string;
  displayName: string;
  providerId: string;
  installCommand: string;
  uninstallCommand: string;
  startCommand: string;
};

export type CodexInstallInput = {
  gatewayUrl: string;
  /**
   * The RouteKit models made available through Codex's model picker.  This
   * remains named `profiles` for API compatibility, although persistent
   * installs now write one RouteKit profile rather than one file per model.
   */
  profiles: readonly CodexInstallProfile[];
  /** Model selected when the single RouteKit profile is first opened. */
  defaultModel?: string;
  /** Safe selector for the one persistent RouteKit profile. */
  profileId?: string;
  /**
   * Pull-based bearer-token helper used by current Codex releases. When
   * omitted, the provider retains the environment-variable contract for
   * callers that manage credentials themselves.
   */
  auth?: {
    command: string;
    args?: readonly string[];
  };
  owner: CodexInstallOwner;
  codexHome?: string;
};

export type CodexInstallResult = {
  configPath: string;
  catalogPath: string;
  action: "installed" | "updated";
  profiles: string[];
};

export function codexIntegrationConfigPath(codexHome: string | undefined): string {
  if (codexHome !== undefined) return join(codexHome, "config.toml");
  const registryPath = SUBSCRIPTIONS.codex.configPath ?? "~/.codex/config.toml";
  return registryPath.startsWith("~/") ? join(homedir(), registryPath.slice(2)) : registryPath;
}

function marker(ownerId: string, edge: "begin" | "end"): string {
  return `# ${edge === "begin" ? ">>>" : "<<<"} ${ownerId} integration ${edge === "begin" ? ">>>" : "<<<"}`;
}

function profileFilesComment(ownerId: string): string {
  return `# ${ownerId}-profile-files:`;
}

function catalogFileComment(ownerId: string): string {
  return `# ${ownerId}-catalog-file:`;
}

function catalogFileName(ownerId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(ownerId)) {
    throw new Error(`Codex integration owner id is not path-safe: ${JSON.stringify(ownerId)}`);
  }
  return `.${ownerId}-model-catalog.json`;
}

function profileFileName(selector: string): string {
  if (
    selector.length === 0 ||
    selector.includes("/") ||
    selector.includes("\\") ||
    selector.startsWith(".")
  ) {
    throw new Error(`Codex profile id is not a safe file name: ${JSON.stringify(selector)}`);
  }
  return `${selector}.config.toml`;
}

function selectedProfileId(input: CodexInstallInput): string {
  return input.profileId ?? input.profiles[0]?.profileId ?? "routekit";
}

function selectedDefaultModel(input: CodexInstallInput): string {
  const model = input.defaultModel ?? input.profiles[0]?.modelId;
  if (model === undefined) throw new Error("at least one Codex catalog model is required");
  if (!input.profiles.some((profile) => profile.modelId === model)) {
    throw new Error(`the Codex default model ${JSON.stringify(model)} is not in the RouteKit catalog`);
  }
  return model;
}

function orderedCatalogProfiles(
  profiles: readonly CodexInstallProfile[],
  defaultModel: string
): CodexInstallProfile[] {
  return [
    ...profiles.filter((profile) => profile.modelId === defaultModel),
    ...profiles.filter((profile) => profile.modelId !== defaultModel)
  ];
}

/** Serialize one additive, owner-marked Codex provider block. */
export function codexIntegrationBlock(input: CodexInstallInput): string {
  const base = gatewayOpenAiBaseUrl(input.gatewayUrl);
  const begin = marker(input.owner.id, "begin");
  const end = marker(input.owner.id, "end");
  const filesComment = profileFilesComment(input.owner.id);
  const catalogComment = catalogFileComment(input.owner.id);
  const catalogFile = catalogFileName(input.owner.id);
  const profileId = selectedProfileId(input);
  const body = tomlStringify({
    model_providers: {
      [input.owner.providerId]: {
        name: `${input.owner.displayName} gateway`,
        base_url: base,
        wire_api: "responses",
        ...(input.auth !== undefined
          ? {
              auth: {
                command: input.auth.command,
                ...(input.auth.args !== undefined ? { args: [...input.auth.args] } : {})
              }
            }
          : {
              requires_openai_auth: false,
              env_key: "ROUTEKIT_GATEWAY_TOKEN"
            })
      }
    }
  });
  return [
    begin,
    `# Managed by \`${input.owner.installCommand}\`; do not edit between these markers.`,
    `# Rerun that command to update; use \`${input.owner.uninstallCommand}\` to remove.`,
    `# Start the gateway first: ${input.owner.startCommand}`,
    `# Then launch: codex --profile ${profileId}`,
    "# That one profile keeps the RouteKit provider selected while Codex's model picker",
    "# reads the catalog below. It does not change your normal Codex default model.",
    `${filesComment} ${profileFileName(profileId)}`,
    `${catalogComment} ${catalogFile}`,
    "",
    body.trimEnd(),
    "",
    end
  ].join("\n");
}

function ownedProfileFiles(
  managed: string | undefined,
  codexHome: string,
  ownerId: string
): string[] {
  if (managed === undefined) return [];
  const prefix = profileFilesComment(ownerId);
  const line = managed.split("\n").find((entry) => entry.startsWith(prefix));
  if (line === undefined) return [];
  return line
    .slice(prefix.length)
    .split(/\s+/)
    .filter((name) => name.endsWith(".config.toml") && !name.includes("/") && !name.includes("\\"))
    .map((name) => join(codexHome, name));
}

function ownedCatalogFile(managed: string | undefined, codexHome: string, ownerId: string): string | undefined {
  if (managed === undefined) return undefined;
  const prefix = catalogFileComment(ownerId);
  const line = managed.split("\n").find((entry) => entry.startsWith(prefix));
  if (line === undefined) return undefined;
  const file = line.slice(prefix.length).trim();
  if (file.length === 0 || file.includes("/") || file.includes("\\") || file !== catalogFileName(ownerId)) {
    return undefined;
  }
  return join(codexHome, file);
}

function splitManagedBlock(
  content: string,
  ownerId: string
): { before: string; managed?: string; after: string } {
  const beginMarker = marker(ownerId, "begin");
  const endMarker = marker(ownerId, "end");
  const begin = content.indexOf(beginMarker);
  if (begin === -1) return { before: content, after: "" };
  const end = content.indexOf(endMarker, begin);
  if (end === -1) {
    throw new Error(
      `found the ${ownerId} begin marker but no end marker in the Codex config; ` +
        `remove the "${beginMarker}" line and its managed content, then retry`
    );
  }
  return {
    before: content.slice(0, begin),
    managed: content.slice(begin, end + endMarker.length),
    after: content.slice(end + endMarker.length)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTomlOrThrow(content: string, what: string): Record<string, unknown> {
  try {
    return tomlParse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`${what} is not valid TOML (${detail}); fix it, then rerun the command`);
  }
}

function assertNoConflicts(
  outside: Record<string, unknown>,
  input: Pick<CodexInstallInput, "owner">
): void {
  const providers = outside.model_providers;
  if (isRecord(providers) && providers[input.owner.providerId] !== undefined) {
    throw new Error(
      `your Codex config already defines [model_providers.${input.owner.providerId}] outside the ` +
        `${input.owner.id}-managed block; remove or rename it, then rerun \`${input.owner.installCommand}\``
    );
  }
}

function normalize(content: string): string {
  const trimmed = content.replace(/\s+$/, "");
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

function removeOwnedProfileFile(path: string, ownerId: string): void {
  try {
    if (!existsSync(path)) return;
    if (!readFileSync(path, "utf8").includes(`Managed by ${ownerId}`)) return;
    rmSync(path);
  } catch {
    // Best-effort cleanup; an orphaned profile does not alter the main config.
  }
}

function assertProfileFileCanBeManaged(path: string, ownerId: string): void {
  if (!existsSync(path)) return;
  if (readFileSync(path, "utf8").includes(`Managed by ${ownerId}`)) return;
  throw new Error(
    `refusing to overwrite an existing Codex profile: ${path}; ` +
      `rename it, then rerun the RouteKit install`
  );
}

export function installCodexIntegration(input: CodexInstallInput): CodexInstallResult {
  if (input.profiles.length === 0) throw new Error("at least one Codex catalog model is required");
  const defaultModel = selectedDefaultModel(input);
  const profileId = selectedProfileId(input);
  const configPath = codexIntegrationConfigPath(input.codexHome);
  const codexHome = dirname(configPath);
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const { before, managed, after } = splitManagedBlock(existing, input.owner.id);
  const outside = parseTomlOrThrow(
    `${normalize(before)}\n${normalize(after)}`,
    `your Codex config (${configPath})`
  );
  assertNoConflicts(outside, input);
  const catalogPath = join(codexHome, catalogFileName(input.owner.id));
  if (managed === undefined && existsSync(catalogPath)) {
    throw new Error(
      `refusing to overwrite an existing RouteKit catalog file: ${catalogPath}; ` +
        `move it aside, then rerun \`${input.owner.installCommand}\``
    );
  }
  const block = codexIntegrationBlock(input);
  const head = normalize(before);
  const tail = normalize(after);
  const next = `${head}${head.length > 0 ? "\n" : ""}${block}\n${tail.length > 0 ? `\n${tail}` : ""}`;
  const assembled = parseTomlOrThrow(next, "the updated Codex config");
  const providers = assembled.model_providers;
  if (!isRecord(providers) || providers[input.owner.providerId] === undefined) {
    throw new Error("internal error: the assembled Codex config lost its managed provider block");
  }
  const persistentProfilePath = join(codexHome, profileFileName(profileId));
  assertProfileFileCanBeManaged(persistentProfilePath, input.owner.id);
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    catalogPath,
    codexPersistentModelCatalogJson(
      orderedCatalogProfiles(input.profiles, defaultModel).map((profile) => ({
        id: profile.modelId,
        ...(profile.reasoning !== undefined ? { reasoning: profile.reasoning } : {})
      })),
      readCodexHomeModelsCache(codexHome)[0]
    ),
    { mode: 0o600 }
  );
  writeFileSync(
    persistentProfilePath,
    `# Managed by ${input.owner.id}\n${codexProfileFileToml(
      defaultModel,
      input.owner.providerId,
      catalogPath
    )}`,
    { mode: 0o600 }
  );
  writeFileSync(configPath, next);
  return {
    configPath,
    catalogPath,
    action: managed !== undefined ? "updated" : "installed",
    profiles: [profileId]
  };
}

export function uninstallCodexIntegration(input: {
  ownerId: string;
  codexHome?: string;
}): { configPath: string; removed: boolean } {
  const configPath = codexIntegrationConfigPath(input.codexHome);
  if (!existsSync(configPath)) return { configPath, removed: false };
  const existing = readFileSync(configPath, "utf8");
  const { before, managed, after } = splitManagedBlock(existing, input.ownerId);
  if (managed === undefined) return { configPath, removed: false };
  for (const owned of ownedProfileFiles(managed, dirname(configPath), input.ownerId)) {
    removeOwnedProfileFile(owned, input.ownerId);
  }
  const catalogPath = ownedCatalogFile(managed, dirname(configPath), input.ownerId);
  if (catalogPath !== undefined) rmSync(catalogPath, { force: true });
  const head = normalize(before);
  const tail = normalize(after);
  writeFileSync(configPath, `${head}${head.length > 0 && tail.length > 0 ? "\n" : ""}${tail}`);
  return { configPath, removed: true };
}
