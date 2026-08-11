import {
  PROVIDERS,
  type ProviderAuthStyle,
  type ProviderInfo
} from "@velum-labs/routekit-registry";

import type { ApiProviderId } from "./provider-types.js";

export function authHeaders(style: ProviderAuthStyle, credential: string): Record<string, string> {
  switch (style) {
    case "bearer":
      return { authorization: `Bearer ${credential}` };
    case "x-api-key":
      return { "x-api-key": credential };
    case "x-goog-api-key":
      return { "x-goog-api-key": credential };
    case "aws-sdk":
      return {};
    default: {
      const unreachable: never = style;
      throw new Error(`unsupported provider auth style: ${String(unreachable)}`);
    }
  }
}

export function providerUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const baseSegments = url.pathname.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);
  let overlap = Math.min(baseSegments.length, pathSegments.length);
  while (
    overlap > 0 &&
    !baseSegments
      .slice(baseSegments.length - overlap)
      .every((segment, index) => segment === pathSegments[index])
  ) {
    overlap -= 1;
  }
  url.pathname = `/${[...baseSegments, ...pathSegments.slice(overlap)].join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function providerMetadata(provider: ApiProviderId): ProviderInfo {
  const info = PROVIDERS[provider];
  if (info?.baseUrl === undefined || info.discovery === undefined || info.wire === undefined) {
    throw new Error(`provider "${provider}" has incomplete registry metadata`);
  }
  return info;
}

export function providerCredential(
  provider: ApiProviderId,
  info: ProviderInfo,
  env: Readonly<Record<string, string | undefined>>
): string {
  const keyEnv = info.keyEnv;
  if (keyEnv === undefined) {
    throw new Error(`provider "${provider}" has no registry-defined credential environment`);
  }
  const value = env[keyEnv];
  if (value === undefined || value.length === 0) {
    throw new Error(`provider "${provider}" is missing credential environment variable ${keyEnv}`);
  }
  return value;
}
