import { basename, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { AccountStoreEntry } from "@velum-labs/routekit-accounts";
import {
  accountStoreEntries,
  CLIPROXY_API_KEY_ENV,
  cliproxyApiKey,
  cliproxyCredentialValid
} from "@velum-labs/routekit-accounts";
import { globalRouterConfigPath, parseRouterConfigDocument } from "@velum-labs/routekit-config";
import type { RouterConfig } from "@velum-labs/routekit-gateway";
import { accountKindForCliproxyAuthType, PROVIDERS, resolveAccountConnector } from "@velum-labs/routekit-registry";
import { ControlError } from "@velum-labs/routekit-runtime";

export function canonicalConfigDocument(path = globalRouterConfigPath()): string {
  if (!existsSync(path)) {
    throw new ControlError({
      code: "unavailable",
      message:
        `canonical router config not found: ${path}; run ` +
        "`routekit config init` or `routekit config import --from <path>`"
    });
  }
  return readFileSync(path, "utf8");
}

export function parseConfigDocument(document: string): RouterConfig {
  try {
    return parseRouterConfigDocument(document, "daemon config update");
  } catch (error) {
    throw new ControlError({
      code: "bad_request",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export function revisionConflict(expected: number, actual: number): never {
  throw new ControlError({
    code: "conflict",
    message: `revision conflict: expected ${expected}, current ${actual}`,
    details: { expected, actual }
  });
}

type WithoutPath<T> = T extends { path: string } ? Omit<T, "path"> : never;
export type AccountEntry = WithoutPath<AccountStoreEntry>;

export function accountEntries(env: NodeJS.ProcessEnv): AccountEntry[] {
  return accountStoreEntries(env).map(({ path: _path, ...entry }) => entry);
}

export function accountEntriesWithPaths(env: NodeJS.ProcessEnv): AccountStoreEntry[] {
  return accountStoreEntries(env);
}

export function providerCredentialAvailable(
  provider: string,
  accounts: readonly AccountEntry[],
  env: NodeJS.ProcessEnv
): boolean {
  if (provider === "claude-code" || provider === "codex") {
    return accounts.some((entry) => entry.subscriptionKind === provider);
  }
  if (provider === "cliproxy") {
    return (env[CLIPROXY_API_KEY_ENV] ?? "").length > 0 || cliproxyApiKey(env) !== undefined;
  }
  const info = PROVIDERS[provider];
  if (info?.keyEnv === undefined) return true;
  return (env[info.keyEnv] ?? "").length > 0;
}

export function safeCredentialBlob(
  kind: "claude-code" | "codex",
  value: unknown
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlError({ code: "bad_request", message: "credential must be an object" });
  }
  const record = structuredClone(value as Record<string, unknown>);
  const valid =
    kind === "claude-code"
      ? typeof (record.claudeAiOauth as Record<string, unknown> | undefined)?.accessToken === "string"
      : typeof (record.tokens as Record<string, unknown> | undefined)?.access_token === "string" ||
        typeof record.access_token === "string";
  if (!valid) {
    throw new ControlError({
      code: "bad_request",
      message: `credential does not have the expected ${kind} token shape`
    });
  }
  return record;
}

export function safeCliproxyCredentialBlob(kind: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlError({ code: "bad_request", message: "credential must be an object" });
  }
  const record = structuredClone(value as Record<string, unknown>);
  const type = typeof record.type === "string" ? record.type : undefined;
  const classified =
    type === undefined ? undefined : accountKindForCliproxyAuthType(type) ?? resolveAccountConnector(type)?.kind;
  if (classified !== kind || !cliproxyCredentialValid(record, type)) {
    throw new ControlError({
      code: "bad_request",
      message: `credential does not have the expected ${kind} connector shape`
    });
  }
  return record;
}

export function safeCliproxyLabel(label: string): string {
  if (label.length === 0 || label.startsWith(".") || basename(label) !== label || label.includes("\\")) {
    throw new ControlError({ code: "bad_request", message: "connector account label is not path-safe" });
  }
  return label;
}

export function dataTokenPath(home: string): string {
  return join(home, "secrets", "data-token");
}

export function redactedProcessArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--auth-token") {
      index += 1;
      result.push("--auth-token", "[REDACTED]");
    } else if (value.startsWith("--auth-token=")) {
      result.push("--auth-token=[REDACTED]");
    } else result.push(value);
  }
  return result;
}
