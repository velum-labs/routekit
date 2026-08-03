import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-gateway";

import {
  assertModelsAvailable,
  DEFAULT_ROUTER_CONFIG,
  configuredProviderIds,
  globalRouterConfigPath,
  loadRouterConfig,
  missingModelIds,
  projectRouterConfigPath,
  resolveModelId,
  updateEffectiveRouterConfig,
  writeRouterConfig
} from "../index.js";

test("default router config uses gpt-5.6-sol", () => {
  assert.equal(DEFAULT_ROUTER_CONFIG.defaultModel, "openai/gpt-5.6-sol");
});

test("router config persists only explicit providers", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-config-sdk-"));
  try {
    const path = projectRouterConfigPath(directory);
    writeRouterConfig(path, {
      providers: { openai: {}, codex: { strategy: "round_robin" } },
      defaultModel: "codex/gpt-5.5"
    });
    const persisted = readFileSync(path, "utf8");
    assert.doesNotMatch(persisted, /switchThreshold|probeIntervalMs/);
    const loaded = loadRouterConfig({
      cwd: directory,
      home: directory,
      env: {}
    });
    assert.equal(loaded.path, path);
    assert.deepEqual(configuredProviderIds(loaded.config), ["openai", "codex"]);
    assert.equal(loaded.config.defaultModel, "codex/gpt-5.5");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("router config persists and loads an explicit unconfigured state", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-config-empty-"));
  try {
    const path = projectRouterConfigPath(directory);
    writeRouterConfig(path, { providers: {} });
    const loaded = loadRouterConfig({
      cwd: directory,
      home: directory,
      env: {}
    });
    assert.deepEqual(configuredProviderIds(loaded.config), []);
    assert.equal(loaded.config.defaultModel, undefined);
    assert.match(readFileSync(path, "utf8"), /^providers: \{\}\n$/);
    assert.throws(() => resolveModelId(loaded.config, []), /router catalog has no models/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("router config rejects inline credentials and legacy endpoint fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-config-sdk-"));
  try {
    assert.throws(
      () =>
        writeRouterConfig(join(directory, "router.yaml"), {
          providers: { openai: { apiKey: "secret" } }
        }),
      /inline credential/
    );
    assert.throws(
      () =>
        writeRouterConfig(join(directory, "router.yaml"), {
          providers: { openai: {} },
          endpoints: []
        }),
      /unrecognized key/i
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider aliases normalize while sparse project mutations stay sparse", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-config-layers-"));
  const home = join(directory, "home");
  const project = join(directory, "project");
  try {
    mkdirSync(project, { recursive: true });
    writeRouterConfig(globalRouterConfigPath(home), {
      providers: { openai: {} }
    });
    const projectPath = projectRouterConfigPath(project);
    mkdirSync(join(project, ".routekit"), { recursive: true });
    writeFileSync(projectPath, "providers:\n  claudeCode:\n    strategy: round_robin\n");

    const loaded = loadRouterConfig({ cwd: project, home, env: {} });
    assert.equal(loaded.config.providers["claude-code"]?.strategy, "round_robin");
    updateEffectiveRouterConfig({ cwd: project, home, env: {} }, (draft) => {
      draft.providers = {
        ...(draft.providers as Record<string, unknown>),
        "claude-code": { switchThreshold: 0.8 }
      };
    });

    const persisted = readFileSync(projectPath, "utf8");
    assert.match(persisted, /claude-code:/);
    assert.doesNotMatch(persisted, /claudeCode|openai|defaultModel/);
    const effective = loadRouterConfig({ cwd: project, home, env: {} }).config;
    assert.equal(effective.providers["claude-code"]?.switchThreshold, 0.8);
    assert.equal(effective.providers.openai?.strategy, "capacity_weighted");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("layered config rejects malformed model policies instead of hiding them", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-config-policy-invalid-"));
  const home = join(directory, "home");
  const project = join(directory, "project");
  try {
    mkdirSync(project, { recursive: true });
    writeRouterConfig(globalRouterConfigPath(home), {
      providers: { openai: {} },
      modelPolicy: { allow: ["openai/*"] }
    });
    const projectPath = projectRouterConfigPath(project);
    mkdirSync(join(project, ".routekit"), { recursive: true });
    writeFileSync(projectPath, "modelPolicy: null\n");

    assert.throws(
      () => loadRouterConfig({ cwd: project, home, env: {} }),
      /modelPolicy/
    );

    writeFileSync(projectPath, "providers: {}\n");
    writeFileSync(globalRouterConfigPath(home), "providers: {}\nmodelPolicy: null\n");
    assert.throws(
      () => loadRouterConfig({ cwd: project, home, env: {} }),
      /modelPolicy/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model policy parses, persists sparsely, and merges fields across layers", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-config-policy-"));
  const home = join(directory, "home");
  const project = join(directory, "project");
  try {
    mkdirSync(project, { recursive: true });
    writeRouterConfig(globalRouterConfigPath(home), {
      providers: { openai: {}, openrouter: {} },
      modelPolicy: {
        allow: ["openai/*", "openrouter/*"],
        deny: ["openai/private"]
      }
    });
    const projectPath = projectRouterConfigPath(project);
    writeRouterConfig(projectPath, {
      providers: {},
      modelPolicy: { allow: ["openrouter/vendor/*"] }
    });

    const loaded = loadRouterConfig({ cwd: project, home, env: {} });
    assert.deepEqual(loaded.config.modelPolicy, {
      allow: ["openrouter/vendor/*"],
      deny: ["openai/private"]
    });
    assert.deepEqual(loaded.config.providers, {
      openai: { strategy: "capacity_weighted", switchThreshold: 0.9 },
      openrouter: { strategy: "capacity_weighted", switchThreshold: 0.9 }
    });

    updateEffectiveRouterConfig({ cwd: project, home, env: {} }, (draft) => {
      draft.modelPolicy = {
        ...(draft.modelPolicy as Record<string, unknown>),
        deny: ["openrouter/vendor/preview"]
      };
    });
    const persisted = readFileSync(projectPath, "utf8");
    assert.match(persisted, /allow:\n    - openrouter\/vendor\/\*/);
    assert.match(persisted, /deny:\n    - openrouter\/vendor\/preview/);
    assert.doesNotMatch(persisted, /openai\/private|openai:\s/);
    assert.deepEqual(loadRouterConfig({ cwd: project, home, env: {} }).config.modelPolicy, {
      allow: ["openrouter/vendor/*"],
      deny: ["openrouter/vendor/preview"]
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const config = parseRouterConfig({
  providers: { openai: {}, codex: {} },
  defaultModel: "codex/gpt-5.6-sol"
});
const catalog = ["openai/gpt-5.6-sol", "codex/gpt-5.6-sol"];

test("resolveModelId validates against the live catalog", () => {
  assert.equal(resolveModelId(config, catalog), "codex/gpt-5.6-sol");
  assert.equal(resolveModelId(config, catalog, "openai/gpt-5.6-sol"), "openai/gpt-5.6-sol");
  assert.throws(
    () => resolveModelId(config, catalog, "openrouter/other"),
    /unknown model "openrouter\/other"/
  );
});
test("model availability helpers preserve required order", () => {
  assert.deepEqual(
    missingModelIds(
      ["codex/gpt-5.6-sol", "google/gemini", "google/gemini", "anthropic/claude"],
      catalog
    ),
    ["google/gemini", "anthropic/claude"]
  );
  assert.doesNotThrow(() => assertModelsAvailable(["codex/gpt-5.6-sol"], catalog));
  assert.throws(
    () => assertModelsAvailable(["google/gemini"], catalog, "bad routes"),
    /bad routes: google\/gemini/
  );
});
