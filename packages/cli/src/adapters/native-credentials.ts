import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { routekitHome } from "@velum-labs/routekit-config";
import { writeFileAtomic } from "@velum-labs/routekit-runtime/filesystem";
import { type KeychainRunner, KeychainSecretStore } from "./keychain-secret-store.js";
import type { NativeIntegrationTool } from "./native-integrations.js";

const KEYCHAIN_SERVICE = "routekit-native";

export type NativeCredentialOptions = {
  platform?: NodeJS.Platform;
  runKeychain?: KeychainRunner;
  home?: string;
};

export type NativeCredentialLocation = {
  keychainService: string;
  keychainAccount: string;
  fallbackPath: string;
};

/**
 * Derive every persistent location for one native-client credential. Keeping
 * this pure lets lifecycle tests verify the real OS store without duplicating
 * account or path derivation.
 */
export function nativeCredentialLocation(
  tool: NativeIntegrationTool,
  configPath: string,
  home = routekitHome()
): NativeCredentialLocation {
  const digest = createHash("sha256")
    .update(`${tool}\u0000${resolve(configPath)}`, "utf8")
    .digest("hex");
  return {
    keychainService: KEYCHAIN_SERVICE,
    keychainAccount: `${tool}-${digest.slice(0, 32)}`,
    fallbackPath: join(home, "secrets", `native-${tool}-${digest}`)
  };
}

/** Private fallback path used on Linux and other platforms without a keychain. */
export function nativeCredentialPath(tool: NativeIntegrationTool, configPath: string): string {
  return nativeCredentialLocation(tool, configPath).fallbackPath;
}

function validateToken(token: string): string {
  const normalized = token.trim();
  if (normalized.length === 0) throw new Error("native gateway token is empty");
  return normalized;
}

export async function writeNativeCredential(
  tool: NativeIntegrationTool,
  configPath: string,
  token: string,
  options: NativeCredentialOptions = {}
): Promise<void> {
  const normalized = validateToken(token);
  if ((options.platform ?? process.platform) === "darwin") {
    const location = nativeCredentialLocation(tool, configPath);
    try {
      await new KeychainSecretStore(location.keychainService, options.runKeychain).write(
        location.keychainAccount,
        normalized
      );
      const fallback = location.fallbackPath;
      if (existsSync(fallback)) unlinkSync(fallback);
      return;
    } catch {
      // Headless macOS sessions may not have a usable login Keychain. Keep
      // the integration functional with the same private 0600 fallback used
      // on Linux; a normal GUI session still takes the Keychain path above.
    }
  }
  const path = nativeCredentialLocation(
    tool,
    configPath,
    options.home ?? routekitHome()
  ).fallbackPath;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileAtomic(path, `${normalized}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function readNativeCredential(
  tool: NativeIntegrationTool,
  configPath: string,
  options: NativeCredentialOptions = {}
): Promise<string | undefined> {
  const fallback = nativeCredentialLocation(
    tool,
    configPath,
    options.home ?? routekitHome()
  ).fallbackPath;
  if (existsSync(fallback)) {
    const token = readFileSync(fallback, "utf8").trim();
    if (token.length > 0) return token;
  }
  if ((options.platform ?? process.platform) === "darwin") {
    const location = nativeCredentialLocation(tool, configPath);
    try {
      return await new KeychainSecretStore(location.keychainService, options.runKeychain).read(
        location.keychainAccount
      );
    } catch {
      // Fall through to the private file fallback.
    }
  }
  if (!existsSync(fallback)) return undefined;
  const token = readFileSync(fallback, "utf8").trim();
  return token.length > 0 ? token : undefined;
}

export async function deleteNativeCredential(
  tool: NativeIntegrationTool,
  configPath: string,
  options: NativeCredentialOptions = {}
): Promise<void> {
  const fallback = nativeCredentialLocation(
    tool,
    configPath,
    options.home ?? routekitHome()
  ).fallbackPath;
  if (existsSync(fallback)) unlinkSync(fallback);
  if ((options.platform ?? process.platform) === "darwin") {
    const location = nativeCredentialLocation(tool, configPath);
    try {
      await new KeychainSecretStore(location.keychainService, options.runKeychain).delete(
        location.keychainAccount
      );
    } catch (error) {
      const candidate = error as { stderr?: string | Buffer };
      const stderr =
        typeof candidate.stderr === "string"
          ? candidate.stderr
          : Buffer.isBuffer(candidate.stderr)
            ? candidate.stderr.toString("utf8")
            : "";
      if (/could not be found|specified item.*not.*found/i.test(stderr)) return;
      // The Keychain command exits non-zero for a missing item, but custom
      // test seams may not include stderr. Treat an absent item as harmless.
      if (stderr.length > 0 && !/could not be found|specified item.*not.*found/i.test(stderr)) {
        throw new Error("could not remove the native gateway token from macOS Keychain");
      }
    }
  }
}
