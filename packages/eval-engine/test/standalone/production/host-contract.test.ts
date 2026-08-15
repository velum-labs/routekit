import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import {
  AUTHOR_HARNESSES,
  ERROR_REQUIRED_KEYS,
  HOST_REQUIRED_KEYS,
  MANIFEST_REQUIRED_KEYS,
  PREPARED_REQUIRED_KEYS,
  SPAWN_COMMANDS,
  SPAWN_EXIT,
  SPAWN_PROTOCOL_VERSION,
  SPAWN_STATUSES,
  WAITING_REQUIRED_KEYS,
} from "../../../src/vendor/eval-system/host-contract.ts";

const fixtures = path.join(import.meta.dirname, "fixtures", "host-contract");

const readFixture = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(fixtures, name), "utf8")) as Record<string, unknown>;

const expectKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  for (const key of keys) assert.ok(Object.hasOwn(value, key), key);
};

describe("spawn host contract fixtures", () => {
  test("freezes protocol version, harnesses, commands, statuses, and exit codes", () => {
    assert.equal(SPAWN_PROTOCOL_VERSION, 2);
    assert.deepEqual(AUTHOR_HARNESSES, ["pi", "claude", "codex"]);
    assert.deepEqual(SPAWN_COMMANDS, [
      "skill",
      "manifest",
      "prepare",
      "run",
      "answer",
      "status",
      "help",
    ]);
    assert.ok(SPAWN_STATUSES.includes("waiting"));
    assert.ok(SPAWN_STATUSES.includes("auth-required"));
    assert.deepEqual(SPAWN_EXIT, { ok: 0, usage: 2, conflict: 3, waiting: 75 });
  });

  test("manifest fixture carries every required key including host", async () => {
    const manifest = await readFixture("manifest.json");
    expectKeys(manifest, MANIFEST_REQUIRED_KEYS);
    assert.equal(manifest.protocolVersion, SPAWN_PROTOCOL_VERSION);
    assert.deepEqual(manifest.authorHarnesses, [...AUTHOR_HARNESSES]);
    expectKeys(manifest.host as Record<string, unknown>, HOST_REQUIRED_KEYS);
  });

  test("prepare, waiting, and error fixtures carry their required keys", async () => {
    expectKeys(await readFixture("prepared.json"), PREPARED_REQUIRED_KEYS);
    expectKeys(await readFixture("waiting.json"), WAITING_REQUIRED_KEYS);
    expectKeys(await readFixture("error.json"), ERROR_REQUIRED_KEYS);
  });
});
