import { trimTrailingSlashes } from "./url.js";

export function gatewayOrigin(value: string): string {
  const trimmed = trimTrailingSlashes(value);
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

export function gatewayOpenAiBaseUrl(value: string): string {
  return `${gatewayOrigin(value)}/v1`;
}

export function gatewayPath(value: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${gatewayOrigin(value)}${normalizedPath}`;
}
