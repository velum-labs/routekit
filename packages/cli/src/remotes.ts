import { isLoopbackHost, trimTrailingSlashes } from "@velum-labs/routekit-runtime/network";

export type RouteKitRemote = {
  name: string;
  gatewayUrl: string;
  sshHost: string;
  addedAt: string;
  tokenId: string;
};

export type RemoteRegistry = {
  version: 1;
  active?: string;
  remotes: RouteKitRemote[];
};

export type RemoteRegistrySnapshot = {
  existed: boolean;
  registry: RemoteRegistry;
};

export function emptyRemoteRegistry(): RemoteRegistry {
  return { version: 1, remotes: [] };
}

export function validateRemoteName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
    throw new Error(
      "remote names must start with a letter or number and contain only letters, numbers, ., _, or -"
    );
  }
}

export function validateSshHost(host: string): void {
  if (
    host.length === 0 ||
    host.length > 255 ||
    host.startsWith("-") ||
    !/^[a-z0-9_.@%:+\[\]-]+$/i.test(host)
  ) {
    throw new Error("SSH host must be a host name, user@host destination, or configured SSH alias");
  }
}

export function normalizeRemoteUrl(value: string): string {
  const url = new URL(value);
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("remote gateway URLs must not contain credentials");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(hostname))) {
    throw new Error("remote gateways require HTTPS unless they use a loopback host");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("remote gateway URLs must not contain a query string or fragment");
  }
  return trimTrailingSlashes(url.toString());
}

export function parseRemoteRegistry(value: unknown, path: string): RemoteRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid RouteKit remote registry: ${path}`);
  }
  const raw = value as { version?: unknown; active?: unknown; remotes?: unknown };
  if (raw.version !== 1 || !Array.isArray(raw.remotes)) {
    throw new Error(`unsupported RouteKit remote registry: ${path}`);
  }
  const remotes = raw.remotes.map((entry): RouteKitRemote => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`invalid RouteKit remote entry: ${path}`);
    }
    const remote = entry as Record<string, unknown>;
    if (
      typeof remote.name !== "string" ||
      typeof remote.gatewayUrl !== "string" ||
      typeof remote.sshHost !== "string" ||
      typeof remote.addedAt !== "string" ||
      typeof remote.tokenId !== "string"
    ) {
      throw new Error(`invalid RouteKit remote entry: ${path}`);
    }
    validateRemoteName(remote.name);
    validateSshHost(remote.sshHost);
    return {
      name: remote.name,
      gatewayUrl: normalizeRemoteUrl(remote.gatewayUrl),
      sshHost: remote.sshHost,
      addedAt: remote.addedAt,
      tokenId: remote.tokenId
    };
  });
  if (new Set(remotes.map((remote) => remote.name)).size !== remotes.length) {
    throw new Error(`RouteKit remote names must be unique: ${path}`);
  }
  const active = typeof raw.active === "string" ? raw.active : undefined;
  if (active !== undefined && !remotes.some((remote) => remote.name === active)) {
    throw new Error(`active RouteKit remote does not exist: ${active}`);
  }
  return { version: 1, remotes, ...(active !== undefined ? { active } : {}) };
}

export function remoteRegistryAfterPut(
  snapshot: RemoteRegistrySnapshot,
  remote: RouteKitRemote,
  activate: boolean
): RemoteRegistry {
  const remotes = snapshot.registry.remotes.filter((entry) => entry.name !== remote.name);
  remotes.push({ ...remote, gatewayUrl: normalizeRemoteUrl(remote.gatewayUrl) });
  remotes.sort((left, right) => left.name.localeCompare(right.name));
  return {
    version: 1,
    remotes,
    ...(activate
      ? { active: remote.name }
      : snapshot.registry.active !== undefined
        ? { active: snapshot.registry.active }
        : {})
  };
}

export function remoteRegistryAfterRemoval(
  snapshot: RemoteRegistrySnapshot,
  name: string
): RemoteRegistry | undefined {
  const remotes = snapshot.registry.remotes.filter((remote) => remote.name !== name);
  if (remotes.length === snapshot.registry.remotes.length) return undefined;
  return {
    version: 1,
    remotes,
    ...(snapshot.registry.active !== name && snapshot.registry.active !== undefined
      ? { active: snapshot.registry.active }
      : {})
  };
}

export function remoteRegistriesEqual(left: RemoteRegistry, right: RemoteRegistry): boolean {
  const validationPath = "<in-memory remote registry>";
  return (
    JSON.stringify(parseRemoteRegistry(left, validationPath)) ===
    JSON.stringify(parseRemoteRegistry(right, validationPath))
  );
}
