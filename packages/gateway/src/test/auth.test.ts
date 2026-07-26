import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import {
  authorizedRequest,
  parsePrincipalHeader,
  resolvePrincipal,
  timingSafeStringEqual,
  verifyBearerToken
} from "../auth.js";

function requestWithHeaders(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("timingSafeStringEqual matches only exact strings", () => {
  assert.equal(timingSafeStringEqual("secret", "secret"), true);
  assert.equal(timingSafeStringEqual("secret", "secre_"), false);
  assert.equal(timingSafeStringEqual("secret", "secret-longer"), false);
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
  assert.equal(authorizedRequest(requestWithHeaders({ authorization: "Bearer nope" }), "tok"), false);
  assert.equal(authorizedRequest(requestWithHeaders({ "x-api-key": "nope" }), "tok"), false);
  assert.equal(authorizedRequest(requestWithHeaders({}), "tok"), false);
});

test("resolvePrincipal uses the registry and falls back to a legacy token", () => {
  const principal = resolvePrincipal(requestWithHeaders({ authorization: "Bearer named" }), {
    resolve: (presented) =>
      presented === "named" ? { id: "abc", label: "bob", role: "admin" } : undefined
  });
  assert.deepEqual(principal, { id: "abc", label: "bob", role: "admin" });
  assert.deepEqual(
    resolvePrincipal(requestWithHeaders({ "x-api-key": "legacy" }), { legacyToken: "legacy" }),
    { id: "default", label: "default", role: "owner" }
  );
  assert.equal(
    resolvePrincipal(requestWithHeaders({ authorization: "Bearer nope" }), {
      resolve: () => undefined,
      legacyToken: "legacy"
    }),
    undefined
  );
});

test("parsePrincipalHeader accepts only well-formed JSON principals", () => {
  assert.deepEqual(parsePrincipalHeader('{"id":"a","label":"bob","role":"admin"}'), {
    id: "a",
    label: "bob",
    role: "admin"
  });
  assert.equal(parsePrincipalHeader('{"id":"a","label":"bob","role":"root"}'), undefined);
  assert.equal(parsePrincipalHeader("not-json"), undefined);
});
