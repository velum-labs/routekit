import type { JsonWebKey } from "node:crypto";
import { createPublicKey, randomUUID, verify } from "node:crypto";

const AWS_NAMESPACE = "https://sts.amazonaws.com/";

export type AwsIdentityClaims = {
  iss: string;
  aud: string | string[];
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  [AWS_NAMESPACE]: {
    aws_account: string;
    source_region?: string;
    ec2_source_instance_arn?: string;
    ec2_instance_source_vpc?: string;
    ec2_role_delivery?: string;
    request_tags?: Record<string, string>;
  };
};

export type Jwk = JsonWebKey & { kid: string; alg?: string; use?: string };

function decodeJson<T>(encoded: string): T {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
}

function audiences(value: string | string[]): string[] {
  return typeof value === "string" ? [value] : value;
}

export function unverifiedAwsIdentityTokenTarget(token: string): {
  issuer: string;
  audiences: string[];
} {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("AWS identity token must have three JWT parts");
  const claims = decodeJson<{ iss?: unknown; aud?: unknown }>(parts[1] as string);
  if (
    typeof claims.iss !== "string" ||
    claims.iss.length === 0 ||
    !(
      typeof claims.aud === "string" ||
      (Array.isArray(claims.aud) &&
        claims.aud.length > 0 &&
        claims.aud.every((entry) => typeof entry === "string" && entry.length > 0))
    )
  ) {
    throw new Error("AWS identity token target is invalid");
  }
  return {
    issuer: claims.iss,
    audiences: typeof claims.aud === "string" ? [claims.aud] : claims.aud
  };
}

function signatureAlgorithm(alg: string): { hash: string; bytes?: number } {
  if (alg === "ES384") return { hash: "sha384", bytes: 96 };
  if (alg === "RS256") return { hash: "sha256" };
  throw new Error(`unsupported AWS JWT algorithm: ${alg}`);
}

export function verifyAwsIdentityToken(input: {
  token: string;
  keys: readonly Jwk[];
  issuer: string;
  audience: string;
  maxLifetimeSeconds: number;
  now?: number;
}): AwsIdentityClaims {
  const parts = input.token.split(".");
  if (parts.length !== 3) throw new Error("AWS identity token must have three JWT parts");
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = decodeJson<{ alg?: unknown; kid?: unknown; typ?: unknown }>(encodedHeader);
  if (
    typeof header.alg !== "string" ||
    typeof header.kid !== "string" ||
    (header.typ !== undefined && header.typ !== "JWT")
  ) {
    throw new Error("AWS identity token header is invalid");
  }
  const algorithm = signatureAlgorithm(header.alg);
  const jwk = input.keys.find((entry) => entry.kid === header.kid && entry.alg === header.alg);
  if (jwk === undefined) throw new Error("AWS identity token signing key is unknown");
  const signature = Buffer.from(encodedSignature, "base64url");
  if (algorithm.bytes !== undefined && signature.length !== algorithm.bytes) {
    throw new Error("AWS identity token signature length is invalid");
  }
  const valid = verify(
    algorithm.hash,
    Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
    algorithm.bytes === undefined
      ? createPublicKey({ key: jwk, format: "jwk" })
      : { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    signature
  );
  if (!valid) throw new Error("AWS identity token signature is invalid");

  const claims = decodeJson<AwsIdentityClaims>(encodedClaims);
  const namespaced = claims[AWS_NAMESPACE];
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (
    claims.iss !== input.issuer ||
    !Array.isArray(audiences(claims.aud)) ||
    !audiences(claims.aud).includes(input.audience) ||
    typeof claims.sub !== "string" ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    typeof claims.jti !== "string" ||
    claims.jti.length === 0 ||
    claims.iat > now + 30 ||
    claims.exp <= now - 30 ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > input.maxLifetimeSeconds ||
    namespaced === null ||
    typeof namespaced !== "object" ||
    typeof namespaced.aws_account !== "string"
  ) {
    throw new Error("AWS identity token claims are invalid");
  }
  return claims;
}

export function unsignedRouteKitJwt(input: {
  kid: string;
  issuer: string;
  audience: string;
  subject: string;
  trustDomain: string;
  routekitPrincipal: string;
  lifetimeSeconds: number;
  now?: number;
}): { signingInput: string; expiresAt: number } {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: input.kid, typ: "JWT" })).toString(
    "base64url"
  );
  const expiresAt = now + input.lifetimeSeconds;
  const claims = Buffer.from(
    JSON.stringify({
      iss: input.issuer,
      aud: input.audience,
      sub: input.subject,
      iat: now,
      nbf: now,
      exp: expiresAt,
      jti: randomUUID(),
      trust_domain: input.trustDomain,
      routekit_principal: input.routekitPrincipal
    })
  ).toString("base64url");
  return { signingInput: `${header}.${claims}`, expiresAt };
}

function readDerLength(input: Buffer, offset: number): { length: number; next: number } {
  const first = input[offset];
  if (first === undefined) throw new Error("truncated DER signature");
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  const bytes = first & 0x7f;
  if (bytes === 0 || bytes > 2) throw new Error("invalid DER signature length");
  let length = 0;
  for (let index = 0; index < bytes; index += 1) {
    const value = input[offset + 1 + index];
    if (value === undefined) throw new Error("truncated DER signature length");
    length = length * 256 + value;
  }
  return { length, next: offset + 1 + bytes };
}

function readDerInteger(input: Buffer, offset: number): { value: Buffer; next: number } {
  if (input[offset] !== 0x02) throw new Error("invalid DER signature integer");
  const decoded = readDerLength(input, offset + 1);
  const end = decoded.next + decoded.length;
  if (end > input.length || decoded.length === 0)
    throw new Error("truncated DER signature integer");
  let value = input.subarray(decoded.next, end);
  while (value.length > 1 && value[0] === 0) value = value.subarray(1);
  if (value.length > 32) throw new Error("DER signature integer exceeds P-256 width");
  return { value, next: end };
}

/** Convert KMS ECDSA DER output into the fixed-width JOSE ES256 signature. */
export function derToJoseEs256(input: Uint8Array): Buffer {
  const der = Buffer.from(input);
  if (der[0] !== 0x30) throw new Error("invalid DER signature sequence");
  const sequence = readDerLength(der, 1);
  if (sequence.next + sequence.length !== der.length) throw new Error("invalid DER signature size");
  const r = readDerInteger(der, sequence.next);
  const s = readDerInteger(der, r.next);
  if (s.next !== der.length) throw new Error("unexpected DER signature content");
  const result = Buffer.alloc(64);
  r.value.copy(result, 32 - r.value.length);
  s.value.copy(result, 64 - s.value.length);
  return result;
}
