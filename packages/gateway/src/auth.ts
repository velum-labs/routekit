/**
 * Shared bearer-token verification for the local gateway servers. One
 * implementation, hardened once: comparisons run over fixed-length digests so
 * neither content nor length differences are observable through timing.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Trusted principal header injected by the switching proxy after auth. */
export const ROUTEKIT_PRINCIPAL_HEADER = "x-routekit-principal";

export type GatewayPrincipal = {
  id: string;
  label: string;
  role: "owner" | "admin";
};

/** Constant-time string equality (length-independent; no timing leaks). */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const aDigest = createHash("sha256").update(a, "utf8").digest();
  const bDigest = createHash("sha256").update(b, "utf8").digest();
  // The digest comparison decides; the direct check only guards the
  // astronomically unlikely hash collision and runs on match alone.
  return timingSafeEqual(aDigest, bDigest) && a === b;
}

/** Verify an `Authorization: Bearer <token>` header value. */
export function verifyBearerToken(header: string | undefined, expected: string): boolean {
  return typeof header === "string" && timingSafeStringEqual(header, `Bearer ${expected}`);
}

/**
 * Extract the presented credential from either `Authorization: Bearer` or
 * `x-api-key`. Returns undefined when neither is present.
 */
export function presentedCredential(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length);
    return token.length > 0 ? token : undefined;
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.length > 0) return apiKey;
  return undefined;
}

/**
 * The gateway's request-authorization rule: a matching bearer token or a
 * matching `x-api-key` header.
 */
export function authorizedRequest(req: IncomingMessage, token: string): boolean {
  if (verifyBearerToken(req.headers.authorization, token)) return true;
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" && timingSafeStringEqual(apiKey, token);
}

/**
 * Resolve a principal from the request using a token registry. Falls back to
 * a single shared token (legacy) when `legacyToken` matches.
 */
export function resolvePrincipal(
  req: IncomingMessage,
  input: {
    resolve?: (presented: string) => GatewayPrincipal | undefined;
    legacyToken?: string;
  }
): GatewayPrincipal | undefined {
  const presented = presentedCredential(req);
  if (presented === undefined) return undefined;
  if (input.resolve !== undefined) {
    const principal = input.resolve(presented);
    if (principal !== undefined) return principal;
  }
  if (input.legacyToken !== undefined && timingSafeStringEqual(presented, input.legacyToken)) {
    return { id: "default", label: "default", role: "owner" };
  }
  return undefined;
}

/** Parse a trusted principal header value injected by the switching proxy. */
export function parsePrincipalHeader(value: string | undefined): GatewayPrincipal | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<GatewayPrincipal>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.label !== "string" ||
      (parsed.role !== "owner" && parsed.role !== "admin")
    ) {
      return undefined;
    }
    return { id: parsed.id, label: parsed.label, role: parsed.role };
  } catch {
    return undefined;
  }
}
