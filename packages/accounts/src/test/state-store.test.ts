import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { VersionedStateStore } from "../state-store.js";

test("versioned state store enforces its declared version before decoding", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-versioned-state-"));
  const path = join(root, "state.json");
  const diagnostics: string[] = [];
  let decoded = false;
  try {
    writeFileSync(path, '{"version":2,"value":"wrong"}\n');
    const store = new VersionedStateStore({
      path,
      version: 1,
      decode: () => {
        decoded = true;
        return "decoded";
      },
      encode: (value: string) => ({ version: 1, value }),
      onDiagnostic: ({ message }) => diagnostics.push(message)
    });

    assert.equal(store.read(), undefined);
    assert.equal(decoded, false);
    assert.deepEqual(diagnostics, ["expected state version 1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("versioned state store rejects encoders that omit the declared version", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-versioned-state-write-"));
  try {
    const store = new VersionedStateStore({
      path: join(root, "state.json"),
      version: 1,
      decode: () => "decoded",
      encode: (value: string) => ({ value })
    });
    assert.throws(() => store.write("value"), /must produce version 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
