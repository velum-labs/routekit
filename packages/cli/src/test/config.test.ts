import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stringify as stringifyYaml } from "yaml";

import {
  loadRouterConfig,
  globalRouterConfigPath,
  writeRouterConfig
} from "../config.js";
import { configImportIdempotencyKey } from "../commands/config.js";

function config(
  provider: "openai" | "anthropic" | "codex",
  model: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    providers: { [provider]: {} },
    defaultModel: `${provider}/${model}`,
    ...extra
  };
}

test("config import idempotency keys include the full operation identity", () => {
  const input = {
    revision: 4,
    document: "providers:\n  openai: {}\n",
    source: "/tmp/first.yaml"
  };
  assert.equal(
    configImportIdempotencyKey(input),
    configImportIdempotencyKey({ ...input })
  );
  assert.notEqual(
    configImportIdempotencyKey(input),
    configImportIdempotencyKey({
      ...input,
      document: "providers:\n  anthropic: {}\n"
    })
  );
  assert.notEqual(
    configImportIdempotencyKey(input),
    configImportIdempotencyKey({ ...input, source: "/tmp/second.yaml" })
  );
});

test("config loading reads the canonical global document or one explicit import candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-test-"));
  const home = join(root, "home");
  writeRouterConfig(
    globalRouterConfigPath(home),
    config("openai", "global", {
      providers: { openai: { fallbackCooldownSeconds: 10 } }
    })
  );
  const explicit = join(root, "explicit.yaml");
  writeRouterConfig(explicit, config("anthropic", "explicit"));

  const canonical = loadRouterConfig({ home });
  assert.equal(canonical.config.defaultModel, "openai/global");
  assert.equal(canonical.config.providers.openai?.fallbackCooldownSeconds, 10);
  const overridden = loadRouterConfig({ home, configPath: explicit });
  assert.equal(overridden.config.defaultModel, "anthropic/explicit");
});

test("config rejects inline credentials and writes atomically with private permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-safe-"));
  const path = join(root, "router.yaml");
  writeRouterConfig(path, config("openai", "safe"));
  assert.equal(statSync(path).mode & 0o777, 0o600);

  writeFileSync(
    path,
    stringifyYaml({
      providers: { openai: { apiKey: "must-not-be-stored" } }
    })
  );
  assert.throws(
    () => loadRouterConfig({ configPath: path }),
    /inline credential field/
  );
  writeFileSync(
    path,
    stringifyYaml({
      providers: {
        google: { headers: { "x-goog-api-key": "must-not-be-stored" } }
      }
    })
  );
  assert.throws(
    () => loadRouterConfig({ configPath: path }),
    /inline credential field "providers\.google\.headers\.x-goog-api-key"/
  );
});

test("config rejects legacy endpoint and provider alias shapes", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-clean-break-"));
  assert.throws(
    () =>
      writeRouterConfig(join(root, "endpoints.yaml"), {
        endpoints: [],
        providers: {}
      }),
    /unrecognized key/i
  );
  assert.throws(
    () =>
      writeRouterConfig(join(root, "alias.yaml"), {
        providers: { claudeCode: {} }
      }),
    /not supported/
  );
});
