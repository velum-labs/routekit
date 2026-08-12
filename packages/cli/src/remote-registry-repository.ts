import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { routekitHome } from "@velum-labs/routekit-config";
import { writeFileAtomic } from "@velum-labs/routekit-runtime";

import {
  emptyRemoteRegistry,
  normalizeRemoteUrl,
  parseRemoteRegistry,
  type RemoteRegistry,
  type RemoteRegistrySnapshot,
  type RouteKitRemote,
  validateRemoteName,
  validateSshHost
} from "./remotes.js";

export class RemoteRegistryRepository {
  path(): string {
    return join(routekitHome(), "remotes.json");
  }

  read(): RemoteRegistry {
    const path = this.path();
    if (!existsSync(path)) return emptyRemoteRegistry();
    return parseRemoteRegistry(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
  }

  write(registry: RemoteRegistry): void {
    const path = this.path();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(path, `${JSON.stringify(parseRemoteRegistry(registry, path), null, 2)}\n`, {
      mode: 0o600
    });
    chmodSync(path, 0o600);
  }

  find(name: string): RouteKitRemote | undefined {
    return this.read().remotes.find((remote) => remote.name === name);
  }

  active(): RouteKitRemote | undefined {
    const registry = this.read();
    return registry.active === undefined
      ? undefined
      : registry.remotes.find((remote) => remote.name === registry.active);
  }

  put(remote: RouteKitRemote, activate = true): void {
    validateRemoteName(remote.name);
    validateSshHost(remote.sshHost);
    const registry = this.read();
    const remotes = registry.remotes.filter((entry) => entry.name !== remote.name);
    remotes.push({ ...remote, gatewayUrl: normalizeRemoteUrl(remote.gatewayUrl) });
    remotes.sort((left, right) => left.name.localeCompare(right.name));
    this.write({
      version: 1,
      remotes,
      ...(activate
        ? { active: remote.name }
        : registry.active !== undefined
          ? { active: registry.active }
          : {})
    });
  }

  snapshot(): RemoteRegistrySnapshot {
    return { existed: existsSync(this.path()), registry: this.read() };
  }

  restore(snapshot: RemoteRegistrySnapshot): void {
    if (!snapshot.existed) {
      const path = this.path();
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    this.write(snapshot.registry);
  }

  use(name: string | undefined): void {
    const registry = this.read();
    if (name !== undefined && !registry.remotes.some((remote) => remote.name === name)) {
      throw new Error(`unknown RouteKit remote: ${name}`);
    }
    this.write({
      version: 1,
      remotes: registry.remotes,
      ...(name !== undefined ? { active: name } : {})
    });
  }
}
