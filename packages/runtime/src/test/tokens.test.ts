import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTokenStore,
  decodeJoinCredential,
  encodeJoinCredential
} from "../tokens.js";

test("token store issues, resolves, lists, and revokes admin tokens", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-tokens-"));
  try {
    const store = createTokenStore(home);
    const issued = store.issue({ label: "bob", plane: "data", createdBy: "alen" });
    assert.equal(issued.label, "bob");
    assert.equal(issued.plane, "data");
    assert.equal(issued.role, "admin");
    assert.ok(issued.token.length > 20);

    const principal = store.resolve(issued.token, "data");
    assert.deepEqual(principal, {
      id: issued.id,
      label: "bob",
      plane: "data",
      role: "admin"
    });
    assert.equal(store.resolve("nope", "data"), undefined);
    assert.equal(store.resolve(issued.token, "control"), undefined);

    const listed = store.list("data");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, issued.id);
    assert.equal("hash" in listed[0]!, false);

    const revoked = store.revoke(issued.id);
    assert.ok(revoked.revokedAt !== undefined);
    assert.equal(store.resolve(issued.token, "data"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("owner data token migrates from legacy file and cannot be revoked", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-tokens-owner-"));
  try {
    const legacy = join(home, "secrets", "data-token");
    const store = createTokenStore(home);
    const { token, principal } = store.ensureOwnerDataToken({
      plaintext: "legacy-owner-token",
      legacyPath: legacy
    });
    assert.equal(token, "legacy-owner-token");
    assert.equal(principal.role, "owner");
    assert.equal(readFileSync(legacy, "utf8").trim(), "legacy-owner-token");
    assert.equal(store.resolve(token, "data")?.role, "owner");
    assert.throws(() => store.revoke(principal.id), /owner token cannot be revoked/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("control plane tokens resolve independently of data tokens", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-tokens-ctl-"));
  try {
    const store = createTokenStore(home);
    const data = store.issue({ label: "data-bob", plane: "data" });
    const control = store.issue({ label: "bob-admin", plane: "control" });
    assert.equal(store.resolve(data.token, "control"), undefined);
    assert.equal(store.resolve(control.token, "data"), undefined);
    assert.equal(store.resolve(control.token, "control")?.label, "bob-admin");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("join credential round-trips path and secret", () => {
  const encoded = encodeJoinCredential({
    publicRecordPath: "/Users/alen/.routekit/services/daemon.public.json",
    token: "control-secret-value"
  });
  assert.match(encoded, /^rk1_/);
  assert.deepEqual(decodeJoinCredential(encoded), {
    publicRecordPath: "/Users/alen/.routekit/services/daemon.public.json",
    token: "control-secret-value"
  });
});

test("join credential rejects bare secrets and malformed payloads", () => {
  assert.throws(
    () => decodeJoinCredential("bare-0.12.0-style-secret"),
    /not a RouteKit join credential/
  );
  assert.throws(() => decodeJoinCredential("rk1_"), /empty after the rk1_ prefix/);
  assert.throws(
    () => decodeJoinCredential(`rk1_${Buffer.from("not-json", "utf8").toString("base64url")}`),
    /not valid JSON/
  );
  assert.throws(
    () =>
      decodeJoinCredential(
        `rk1_${Buffer.from(JSON.stringify({ v: 2, p: "/abs", t: "x" }), "utf8").toString("base64url")}`
      ),
    /unsupported join credential version/
  );
  assert.throws(
    () =>
      decodeJoinCredential(
        `rk1_${Buffer.from(JSON.stringify({ v: 1, t: "x" }), "utf8").toString("base64url")}`
      ),
    /missing the public record path/
  );
  assert.throws(
    () =>
      decodeJoinCredential(
        `rk1_${Buffer.from(JSON.stringify({ v: 1, p: "/abs" }), "utf8").toString("base64url")}`
      ),
    /missing the control token/
  );
  assert.throws(
    () =>
      decodeJoinCredential(
        `rk1_${Buffer.from(
          JSON.stringify({ v: 1, p: "relative/path", t: "x" }),
          "utf8"
        ).toString("base64url")}`
      ),
    /must be absolute/
  );
  assert.throws(
    () =>
      encodeJoinCredential({
        publicRecordPath: "relative/path",
        token: "x"
      }),
    /must be absolute/
  );
  assert.throws(
    () =>
      encodeJoinCredential({
        publicRecordPath: "/abs",
        token: ""
      }),
    /token is empty/
  );
});
