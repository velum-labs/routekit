import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertModelsAvailable,
  configuredProviderIds,
  globalRouterConfigPath,
  loadRouterConfig,
  missingModelIds,
  parseRouterConfig,
  resolveModelId,
  updateRouterConfig,
  writeRouterConfig
} from "../index.js";

test("router config loads only the canonical global document", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-config-global-"));
  try {
    const path = globalRouterConfigPath(home);
    writeRouterConfig(path, {
      providers: { openai: {}, codex: { strategy: "round_robin" } },
      defaultModel: "codex/gpt-5.5"
    });
    const loaded = loadRouterConfig({ home });
    assert.equal(loaded.path, path);
    assert.deepEqual(configuredProviderIds(loaded.config), ["openai", "codex"]);
    assert.equal(loaded.config.defaultModel, "codex/gpt-5.5");
    assert.doesNotMatch(readFileSync(path, "utf8"), /switchThreshold|probeIntervalMs/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an explicit path is read as one complete document, never layered", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-explicit-"));
  try {
    const global = globalRouterConfigPath(root);
    const explicit = join(root, "incoming.yaml");
    writeRouterConfig(global, {
      providers: { openai: {} },
      defaultModel: "openai/gpt-5.5"
    });
    writeRouterConfig(explicit, {
      providers: { codex: {} },
      defaultModel: "codex/gpt-5.5"
    });
    const loaded = loadRouterConfig({ home: root, configPath: explicit });
    assert.equal(loaded.path, explicit);
    assert.deepEqual(configuredProviderIds(loaded.config), ["codex"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("router config rejects credentials, retired aliases, and retired endpoint shapes", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-config-clean-break-"));
  try {
    assert.throws(
      () =>
        writeRouterConfig(join(directory, "credential.yaml"), {
          providers: { openai: { apiKey: "secret" } }
        }),
      /inline credential/
    );
    assert.throws(
      () =>
        writeRouterConfig(join(directory, "endpoint.yaml"), {
          providers: {},
          endpoints: []
        }),
      /unrecognized key/i
    );
    for (const provider of ["claude", "claudeCode"]) {
      assert.throws(
        () =>
          writeRouterConfig(join(directory, `${provider}.yaml`), {
            providers: { [provider]: {} }
          }),
        /not supported/
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical updates mutate and validate one owned document", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-update-"));
  const path = globalRouterConfigPath(root);
  try {
    writeRouterConfig(path, { providers: { openai: {} } });
    const config = updateRouterConfig(path, (draft) => {
      draft.providers = { ...(draft.providers as object), "claude-code": {} };
      draft.defaultModel = "claude-code/claude-sonnet-4-5";
    });
    assert.deepEqual(configuredProviderIds(config), ["openai", "claude-code"]);
    assert.equal(
      loadRouterConfig({ home: root }).config.defaultModel,
      "claude-code/claude-sonnet-4-5"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const config = parseRouterConfig({
  providers: { openai: {}, codex: {} },
  defaultModel: "codex/gpt-5.5"
});
const catalog = ["openai/gpt-5.5", "codex/gpt-5.5"];

test("resolveModelId validates against the live catalog", () => {
  assert.equal(resolveModelId(config, catalog), "codex/gpt-5.5");
  assert.equal(resolveModelId(config, catalog, "openai/gpt-5.5"), "openai/gpt-5.5");
  assert.throws(() => resolveModelId(config, catalog, "openrouter/other"), /unknown model/);
});

test("model availability helpers preserve required order", () => {
  assert.deepEqual(
    missingModelIds(
      ["codex/gpt-5.5", "google/gemini", "google/gemini", "anthropic/claude"],
      catalog
    ),
    ["google/gemini", "anthropic/claude"]
  );
  assert.throws(() => assertModelsAvailable(["missing/model"], catalog), /missing models/);
});
