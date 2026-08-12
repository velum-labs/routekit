/**
 * Shared bearer-token verification for the local gateway servers. One
 * implementation, hardened once: comparisons run over equally sized buffers
 * so neither content nor length differences are observable through timing.
 */
import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

/** Trusted principal header injected by the switching proxy after auth. */
export const ROUTEKIT_PRINCIPAL_HEADER = "x-routekit-principal";

export type GatewayPrincipal = {
  id: string;
  label: string;
  role: "owner" | "admin";
};

export type WorkloadJwtPrincipalPolicy = {
  /** Exact AWS workload identity subject accepted by the broker. */
  subject: string;
  /** Immutable isolation boundary carried in the signed credential. */
  trustDomain: string;
  /** RouteKit principal carried in the signed credential. */
  principal: string;
  role?: "owner" | "admin";
};

export type WorkloadJwtVerifierOptions = {
  issuer: string;
  audience: string;
  /** ES256 public keys keyed by the JWT `kid`. */
  publicKeys: Readonly<Record<string, string>>;
  principals: readonly WorkloadJwtPrincipalPolicy[];
  /** Maximum permitted credential lifetime. Defaults to ten minutes. */
  maxLifetimeSeconds?: number;
  /** Clock tolerance for distributed hosts. Defaults to 30 seconds. */
  clockSkewSeconds?: number;
  /** Test seam. Production callers should leave this unset. */
  now?: () => number;
};

type WorkloadJwtHeader = { alg: string; kid: string; typ?: string };
type WorkloadJwtClaims = {
  iss: string;
  aud: string | string[];
  sub: string;
  iat: number;
  nbf?: number;
  exp: number;
  jti: string;
  trust_domain: string;
  routekit_principal: string;
};

function decodeJwtPart<T>(value: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

function validJwtHeader(value: unknown): value is WorkloadJwtHeader {
  if (value === null || typeof value !== "object") return false;
  const header = value as Partial<WorkloadJwtHeader>;
  return (
    header.alg === "ES256" &&
    typeof header.kid === "string" &&
    header.kid.length > 0 &&
    (header.typ === undefined || header.typ === "JWT")
  );
}

function validClaimsShape(value: unknown): value is WorkloadJwtClaims {
  if (value === null || typeof value !== "object") return false;
  const claims = value as Partial<WorkloadJwtClaims>;
  return (
    typeof claims.iss === "string" &&
    (typeof claims.aud === "string" ||
      (Array.isArray(claims.aud) && claims.aud.every((entry) => typeof entry === "string"))) &&
    typeof claims.sub === "string" &&
    Number.isInteger(claims.iat) &&
    (claims.nbf === undefined || Number.isInteger(claims.nbf)) &&
    Number.isInteger(claims.exp) &&
    typeof claims.jti === "string" &&
    claims.jti.length > 0 &&
    typeof claims.trust_domain === "string" &&
    typeof claims.routekit_principal === "string"
  );
}

function includesAudience(value: string | string[], expected: string): boolean {
  return typeof value === "string" ? value === expected : value.includes(expected);
}

/**
 * Build a synchronous ES256 verifier for short-lived RouteKit workload JWTs.
 *
 * Public keys and authorization mappings are immutable configuration. The
 * bearer credential remains memory-only at callers and is never registered in
 * RouteKit's durable token store.
 */
export function createWorkloadJwtVerifier(
  options: WorkloadJwtVerifierOptions
): (presented: string) => GatewayPrincipal | undefined {
  const maxLifetime = options.maxLifetimeSeconds ?? 10 * 60;
  const skew = options.clockSkewSeconds ?? 30;
  if (!Number.isInteger(maxLifetime) || maxLifetime <= 0) {
    throw new Error("workload JWT maxLifetimeSeconds must be a positive integer");
  }
  if (!Number.isInteger(skew) || skew < 0) {
    throw new Error("workload JWT clockSkewSeconds must be a non-negative integer");
  }
  const publicKeys = new Map(
    Object.entries(options.publicKeys).map(([kid, pem]) => [kid, createPublicKey(pem)] as const)
  );
  if (publicKeys.size === 0) throw new Error("workload JWT requires at least one public key");

  const policies = new Map<string, WorkloadJwtPrincipalPolicy>();
  for (const policy of options.principals) {
    const key = `${policy.subject}\u0000${policy.trustDomain}\u0000${policy.principal}`;
    if (policies.has(key)) throw new Error("duplicate workload JWT principal policy");
    policies.set(key, policy);
  }
  if (policies.size === 0) throw new Error("workload JWT requires at least one principal policy");

  return (presented): GatewayPrincipal | undefined => {
    const parts = presented.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) return undefined;
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
    const header = decodeJwtPart<unknown>(encodedHeader);
    const claims = decodeJwtPart<unknown>(encodedClaims);
    if (!validJwtHeader(header) || !validClaimsShape(claims)) return undefined;
    const publicKey = publicKeys.get(header.kid);
    if (publicKey === undefined) return undefined;

    let signature: Buffer;
    try {
      signature = Buffer.from(encodedSignature, "base64url");
    } catch {
      return undefined;
    }
    if (signature.length !== 64) return undefined;
    const verified = verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature
    );
    if (!verified) return undefined;

    const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
    if (
      claims.iss !== options.issuer ||
      !includesAudience(claims.aud, options.audience) ||
      claims.iat > now + skew ||
      (claims.nbf ?? claims.iat) > now + skew ||
      claims.exp <= now - skew ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > maxLifetime
    ) {
      return undefined;
    }

    const policy = policies.get(
      `${claims.sub}\u0000${claims.trust_domain}\u0000${claims.routekit_principal}`
    );
    if (policy === undefined) return undefined;
    return {
      id: `workload:${claims.trust_domain}:${claims.sub}`,
      label: claims.routekit_principal,
      role: policy.role ?? "admin"
    };
  };
}

/** Constant-time string equality (length-independent; no timing leaks). */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, "utf8");
  const bBytes = Buffer.from(b, "utf8");
  const length = Math.max(aBytes.length, bBytes.length, 1);
  const aPadded = Buffer.alloc(length);
  const bPadded = Buffer.alloc(length);
  aBytes.copy(aPadded);
  bBytes.copy(bPadded);
  return timingSafeEqual(aPadded, bPadded) && aBytes.length === bBytes.length;
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
  return authorizedHeaders(req.headers, token);
}

export function authorizedHeaders(headers: IncomingHttpHeaders, token: string): boolean {
  if (verifyBearerToken(headers.authorization, token)) return true;
  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" && timingSafeStringEqual(apiKey, token);
}

/** Resolve a principal from the request using the configured token registry. */
export function resolvePrincipal(
  req: IncomingMessage,
  resolve: (presented: string) => GatewayPrincipal | undefined
): GatewayPrincipal | undefined {
  const presented = presentedCredential(req);
  if (presented === undefined) return undefined;
  return resolve(presented);
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
