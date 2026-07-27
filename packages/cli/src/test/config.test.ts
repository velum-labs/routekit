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
  convertLegacyRouterConfig,
  loadRouterConfig,
  migrateLegacyRouterConfig,
  projectRouterConfigPath,
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

test("project config overrides global and explicit config overrides both", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-test-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const nested = join(project, "src");
  mkdirSync(nested, { recursive: true });
  writeRouterConfig(
    join(home, ".config", "routekit", "router.yaml"),
    config("openai", "global", {
      providers: { openai: { fallbackCooldownSeconds: 10 } }
    })
  );
  writeRouterConfig(projectRouterConfigPath(project), config("codex", "project"));
  const explicit = join(root, "explicit.yaml");
  writeRouterConfig(explicit, config("anthropic", "explicit"));

  const layered = loadRouterConfig({ cwd: nested, home, env: {} });
  assert.equal(layered.config.defaultModel, "codex/project");
  assert.equal(layered.config.providers.openai?.fallbackCooldownSeconds, 10);
  assert.deepEqual(layered.sources, ["project", "global"]);

  const overridden = loadRouterConfig({
    cwd: nested,
    home,
    env: { ROUTEKIT_CONFIG: explicit }
  });
  assert.equal(overridden.config.defaultModel, "anthropic/explicit");
  assert.deepEqual(overridden.sources, ["environment"]);
});

test("project overlays merge providers and individual policy fields", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-accounts-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  writeRouterConfig(
    join(home, ".config", "routekit", "router.yaml"),
    config("openai", "gpt", {
      providers: {
        openai: {},
        codex: {
          strategy: "round_robin",
          switchThreshold: 0.75
        }
      }
    })
  );
  writeRouterConfig(
    projectRouterConfigPath(project),
    {
      providers: {
        claudeCode: {},
        codex: { probeIntervalMs: 12_000 }
      }
    }
  );

  const loaded = loadRouterConfig({ cwd: project, home, env: {} });
  assert.equal(loaded.config.providers["claude-code"]?.strategy, "capacity_weighted");
  assert.equal(loaded.config.providers.codex?.strategy, "round_robin");
  assert.equal(loaded.config.providers.codex?.switchThreshold, 0.75);
  assert.equal(loaded.config.providers.codex?.probeIntervalMs, 12_000);
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
    () => loadRouterConfig({ configPath: path, env: {} }),
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
    () => loadRouterConfig({ configPath: path, env: {} }),
    /inline credential field "providers\.google\.headers\.x-goog-api-key"/
  );
});

test("legacy endpoint/account config converts with explicit alias diagnostics", () => {
  const result = convertLegacyRouterConfig({
    endpoints: [
      {
        endpointId: "gpt",
        model: "gpt-5.5",
        account: "codex"
      },
      {
        endpointId: "kimi",
        model: "moonshotai/kimi-k2-thinking",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY"
      }
    ],
    defaultEndpointId: "gpt",
    accounts: {
      codex: { enabled: true, strategy: "round_robin" }
    }
  });
  assert.equal(result.changed, true);
  assert.deepEqual(Object.keys(result.config?.providers ?? {}), [
    "openrouter",
    "codex"
  ]);
  assert.equal(result.config?.defaultModel, "codex/gpt-5.5");
  assert.equal(result.config?.providers.codex?.strategy, "round_robin");
  assert.equal(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "custom-alias")
      .length,
    2
  );
});

test("legacy migration reports non-representable pools and custom URLs without writing", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-convert-"));
  const path = join(root, "router.yaml");
  const legacy = stringifyYaml({
    endpoints: [
      {
        endpointId: "pooled",
        instanceId: "one",
        model: "gpt",
        provider: "openai",
        baseUrl: "https://custom.example/v1"
      }
    ]
  });
  writeFileSync(path, legacy);
  const result = migrateLegacyRouterConfig(path);
  assert.equal(result.changed, false);
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code === "endpoint-pool"),
    true
  );
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code === "custom-url"),
    true
  );
  assert.equal(readFileSync(path, "utf8"), legacy);
});
