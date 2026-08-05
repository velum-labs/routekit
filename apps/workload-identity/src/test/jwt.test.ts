import assert from "node:assert/strict";
import type { JsonWebKey } from "node:crypto";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { derToJoseEs256, unsignedRouteKitJwt, verifyAwsIdentityToken } from "../jwt.js";

test("AWS ES384 tokens are verified against issuer, audience, role, and session claims", () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-384" });
  const now = 1_800_000_000;
  const header = Buffer.from(JSON.stringify({ alg: "ES384", kid: "aws-key", typ: "JWT" })).toString(
    "base64url"
  );
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://issuer.tokens.sts.global.api.aws",
      aud: "routekit-broker",
      sub: "arn:aws:iam::123456789012:role/factory-private",
      iat: now - 5,
      exp: now + 295,
      jti: "aws-jti",
      "https://sts.amazonaws.com/": {
        aws_account: "123456789012",
        source_region: "us-west-2",
        ec2_instance_source_vpc: "vpc-123",
        ec2_role_delivery: "2.0"
      }
    })
  ).toString("base64url");
  const signature = sign("sha384", Buffer.from(`${header}.${claims}`), {
    key: pair.privateKey,
    dsaEncoding: "ieee-p1363"
  }).toString("base64url");
  const verified = verifyAwsIdentityToken({
    token: `${header}.${claims}.${signature}`,
    keys: [
      {
        ...(pair.publicKey.export({ format: "jwk" }) as JsonWebKey),
        kid: "aws-key",
        alg: "ES384"
      }
    ],
    issuer: "https://issuer.tokens.sts.global.api.aws",
    audience: "routekit-broker",
    maxLifetimeSeconds: 300,
    now
  });
  assert.equal(verified.sub, "arn:aws:iam::123456789012:role/factory-private");
});

test("KMS DER signatures convert to the fixed-width JOSE form", () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const message = Buffer.from("signed input");
  const der = sign("sha256", message, { key: pair.privateKey, dsaEncoding: "der" });
  const jose = derToJoseEs256(der);
  assert.equal(jose.length, 64);
  const jwt = unsignedRouteKitJwt({
    kid: "kms-key-v1",
    issuer: "https://credentials.routekit.internal",
    audience: "routekit-gateway",
    subject: "arn:aws:iam::123456789012:role/factory-private",
    trustDomain: "factory-private",
    routekitPrincipal: "factory-t3-private",
    lifetimeSeconds: 300,
    now: 1_800_000_000
  });
  assert.match(jwt.signingInput, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(jwt.expiresAt, 1_800_000_300);
});
