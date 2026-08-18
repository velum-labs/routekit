import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import {
  authorizedRequest,
  createWorkloadJwtVerifier,
  parsePrincipalHeader,
  resolvePrincipal,
  timingSafeStringEqual,
  verifyBearerToken
} from "../http/auth.js";

function jwt(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "ES256", kid: "kms-key-1", typ: "JWT" }
): string {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${encodedHeader}.${encodedClaims}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363"
  }).toString("base64url");
  return `${encodedHeader}.${encodedClaims}.${signature}`;
}

function requestWithHeaders(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("timingSafeStringEqual matches only exact strings", () => {
  assert.equal(timingSafeStringEqual("secret", "secret"), true);
  assert.equal(timingSafeStringEqual("secret", "secre_"), false);
  assert.equal(timingSafeStringEqual("secret", "secret-longer"), false);
  assert.equal(timingSafeStringEqual("secret\0", "secret"), false);
  assert.equal(timingSafeStringEqual("é", "e\u0301"), false);
  assert.equal(timingSafeStringEqual("", ""), true);
});

test("verifyBearerToken requires the Bearer prefix and exact token", () => {
  assert.equal(verifyBearerToken("Bearer tok", "tok"), true);
  assert.equal(verifyBearerToken("bearer tok", "tok"), false);
  assert.equal(verifyBearerToken("tok", "tok"), false);
  assert.equal(verifyBearerToken(undefined, "tok"), false);
});

test("authorizedRequest accepts bearer header or x-api-key, rejects otherwise", () => {
  assert.equal(authorizedRequest(requestWithHeaders({ authorization: "Bearer tok" }), "tok"), true);
  assert.equal(authorizedRequest(requestWithHeaders({ "x-api-key": "tok" }), "tok"), true);
  assert.equal(
    authorizedRequest(requestWithHeaders({ authorization: "Bearer nope" }), "tok"),
    false
  );
  assert.equal(authorizedRequest(requestWithHeaders({ "x-api-key": "nope" }), "tok"), false);
  assert.equal(authorizedRequest(requestWithHeaders({}), "tok"), false);
});

test("resolvePrincipal uses the token registry", () => {
  const resolve = (presented: string) =>
    presented === "named" ? { id: "abc", label: "bob", role: "admin" as const } : undefined;
  const principal = resolvePrincipal(
    requestWithHeaders({ authorization: "Bearer named" }),
    resolve
  );
  assert.deepEqual(principal, { id: "abc", label: "bob", role: "admin" });
  assert.equal(
    resolvePrincipal(requestWithHeaders({ authorization: "Bearer nope" }), resolve),
    undefined
  );
});

test("parsePrincipalHeader accepts only well-formed JSON principals", () => {
  assert.deepEqual(parsePrincipalHeader('{"id":"a","label":"bob","role":"admin"}'), {
    id: "a",
    label: "bob",
    role: "admin"
  });
  assert.deepEqual(
    parsePrincipalHeader(
      JSON.stringify({
        id: "eval-token",
        label: "eval-session",
        role: "eval",
        evalSession: {
          sessionId: "session-1",
          allowedModels: ["openai/gpt-5.6-luna"],
          expiresAt: "2026-08-18T00:00:00.000Z"
        }
      })
    ),
    {
      id: "eval-token",
      label: "eval-session",
      role: "eval",
      evalSession: {
        sessionId: "session-1",
        allowedModels: ["openai/gpt-5.6-luna"],
        expiresAt: "2026-08-18T00:00:00.000Z"
      }
    }
  );
  assert.equal(
    parsePrincipalHeader('{"id":"eval-token","label":"eval-session","role":"eval"}'),
    undefined
  );
  assert.equal(parsePrincipalHeader('{"id":"a","label":"bob","role":"root"}'), undefined);
  assert.equal(parsePrincipalHeader("not-json"), undefined);
});

test("workload JWT verifier accepts only signed, mapped, short-lived credentials", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const now = 1_800_000_000;
  const verify = createWorkloadJwtVerifier({
    issuer: "https://credentials.routekit.internal",
    audience: "routekit-gateway",
    publicKeys: {
      "kms-key-1": publicKey.export({ type: "spki", format: "pem" }).toString()
    },
    principals: [
      {
        subject: "arn:aws:sts::123456789012:assumed-role/factory-private-runtime/i-abc",
        trustDomain: "factory-private",
        principal: "factory-t3-private"
      }
    ],
    now: () => now * 1000
  });
  const claims = {
    iss: "https://credentials.routekit.internal",
    aud: "routekit-gateway",
    sub: "arn:aws:sts::123456789012:assumed-role/factory-private-runtime/i-abc",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 295,
    jti: "request-1",
    trust_domain: "factory-private",
    routekit_principal: "factory-t3-private"
  };
  assert.deepEqual(verify(jwt(privateKey, claims)), {
    id: `workload:factory-private:${claims.sub}`,
    label: "factory-t3-private",
    role: "admin"
  });
  assert.equal(verify(jwt(privateKey, { ...claims, exp: now + 601 })), undefined);
  assert.equal(verify(jwt(privateKey, { ...claims, trust_domain: "factory-public" })), undefined);
  assert.equal(verify(jwt(privateKey, { ...claims, aud: "some-other-service" })), undefined);
  assert.equal(verify(jwt(privateKey, claims, { alg: "none", kid: "kms-key-1" })), undefined);

  const attacker = generateKeyPairSync("ec", { namedCurve: "P-256" });
  assert.equal(verify(jwt(attacker.privateKey, claims)), undefined);
});
