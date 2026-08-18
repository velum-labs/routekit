import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { routekitHome } from "@velum-labs/routekit-config";
import { writeFileAtomic } from "@velum-labs/routekit-runtime";

import { type KeychainRunner, KeychainSecretStore } from "../adapters/keychain-secret-store.js";
import { validateRemoteName } from "../remotes.js";

const KEYCHAIN_SERVICE = "routekit-remote";

export type RemoteCredentialOptions = {
  platform?: NodeJS.Platform;
  runKeychain?: KeychainRunner;
};

export class RemoteCredentialRepository {
  constructor(private readonly options: RemoteCredentialOptions = {}) {}

  path(name: string): string {
    return join(routekitHome(), "secrets", `remote-${name}`);
  }

  async write(name: string, token: string): Promise<void> {
    validateRemoteName(name);
    if (token.trim().length === 0) throw new Error("remote gateway token is empty");
    if ((this.options.platform ?? process.platform) === "darwin") {
      try {
        await new KeychainSecretStore(KEYCHAIN_SERVICE, this.options.runKeychain).write(
          name,
          token.trim()
        );
      } catch {
        throw new Error(`could not store the gateway token for remote "${name}" in Keychain`);
      }
      return;
    }
    const path = this.path(name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(path, `${token.trim()}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  async read(name: string): Promise<string | undefined> {
    validateRemoteName(name);
    if ((this.options.platform ?? process.platform) === "darwin") {
      try {
        return await new KeychainSecretStore(KEYCHAIN_SERVICE, this.options.runKeychain).read(name);
      } catch {
        return undefined;
      }
    }
    const path = this.path(name);
    if (!existsSync(path)) return undefined;
    const token = readFileSync(path, "utf8").trim();
    return token.length > 0 ? token : undefined;
  }

  async delete(name: string): Promise<void> {
    validateRemoteName(name);
    if ((this.options.platform ?? process.platform) === "darwin") {
      try {
        await new KeychainSecretStore(KEYCHAIN_SERVICE, this.options.runKeychain).delete(name);
      } catch (error) {
        throw new Error(`could not delete the gateway token for remote "${name}" from Keychain`);
      }
      return;
    }
    const path = this.path(name);
    if (existsSync(path)) unlinkSync(path);
  }
}
