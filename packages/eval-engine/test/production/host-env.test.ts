import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Redacted } from "effect";

import {
  ANTHROPIC_BASE_URL_ENV,
  applyHostProviderEnv,
  DEFAULT_EVAL_API_BASE_URL,
  EVAL_API_BASE_URL_ENV,
  evalApiBaseUrl,
  evalModelEndpointsUrlBase,
  evalModelsCatalogUrl,
  evalOpenAiCompatibleUrl,
  hostCredentialPresent,
  OPENROUTER_API_KEY_ENV,
  PI_CODING_AGENT_DIR_ENV,
  withHostProviderEnvironment,
  withProcessEnvOverlay,
} from "../../src/host-env.ts";
import { ensureIsolatedOriChildAuth } from "../../src/isolated-ori-child-auth.ts";
import { fetchOpenRouterModelEndpoints } from "../../src/vendor/framework/contracts/author/src/openrouter-endpoints.ts";
import { fetchOpenRouterModels } from "../../src/vendor/framework/contracts/author/src/openrouter-models.ts";
import { mergePiModelsConfig } from "../../src/vendor/framework/builtins/harness-pi/src/openrouter-attribution/openrouter-attribution.ts";
import { buildClaudeProcessEnv } from "../../src/vendor/framework/runloop/adapters/adapter-claude-acp/src/native/process-config.ts";

const GATEWAY = "https://gateway.example/api";

describe("host provider env", () => {
  test("defaults catalog, endpoints, and Pi URLs to OpenRouter", () => {
    const env = {};
    assert.equal(evalApiBaseUrl(env), DEFAULT_EVAL_API_BASE_URL);
    assert.equal(
      evalModelsCatalogUrl(env),
      "https://openrouter.ai/api/v1/models?sort=top-weekly",
    );
    assert.equal(evalModelEndpointsUrlBase(env), "https://openrouter.ai/api/v1/models");
    assert.equal(evalOpenAiCompatibleUrl(env), "https://openrouter.ai/api/v1");
  });

  test("strips trailing slashes and treats blank overlay as unset", () => {
    assert.equal(
      evalApiBaseUrl({ [EVAL_API_BASE_URL_ENV]: " https://gw.example/api/// " }),
      "https://gw.example/api",
    );
    assert.equal(evalApiBaseUrl({ [EVAL_API_BASE_URL_ENV]: "   " }), DEFAULT_EVAL_API_BASE_URL);
  });

  test("reports an environment credential only when the key is non-empty", () => {
    assert.equal(hostCredentialPresent({}), false);
    assert.equal(hostCredentialPresent({ [OPENROUTER_API_KEY_ENV]: "   " }), false);
    assert.equal(hostCredentialPresent({ [OPENROUTER_API_KEY_ENV]: "sk-or-v1-test" }), true);
  });

  test("copies a custom origin onto ANTHROPIC_BASE_URL unless the caller set one", () => {
    const env: Record<string, string | undefined> = { [EVAL_API_BASE_URL_ENV]: GATEWAY };
    applyHostProviderEnv(env);
    assert.equal(env[ANTHROPIC_BASE_URL_ENV], GATEWAY);

    const explicit: Record<string, string | undefined> = {
      [EVAL_API_BASE_URL_ENV]: GATEWAY,
      [ANTHROPIC_BASE_URL_ENV]: "https://api.anthropic.com",
    };
    applyHostProviderEnv(explicit);
    assert.equal(explicit[ANTHROPIC_BASE_URL_ENV], "https://api.anthropic.com");

    const defaults: Record<string, string | undefined> = {};
    applyHostProviderEnv(defaults);
    assert.equal(defaults[ANTHROPIC_BASE_URL_ENV], undefined);
  });

  test("overlays host provider keys onto process.env and restores them", async () => {
    const previous = process.env[ANTHROPIC_BASE_URL_ENV];
    process.env[ANTHROPIC_BASE_URL_ENV] = "https://api.anthropic.com";
    await withProcessEnvOverlay({ [ANTHROPIC_BASE_URL_ENV]: GATEWAY }, async () => {
      assert.equal(process.env[ANTHROPIC_BASE_URL_ENV], GATEWAY);
    });
    assert.equal(process.env[ANTHROPIC_BASE_URL_ENV], "https://api.anthropic.com");
    if (previous === undefined) delete process.env[ANTHROPIC_BASE_URL_ENV];
    else process.env[ANTHROPIC_BASE_URL_ENV] = previous;
  });

  test("points isolated HOME at a Pi agent dir and seeds bridge auth files", async () => {
    const home = await mkdtemp(join(tmpdir(), "ori-child-auth-"));
    const env: Record<string, string | undefined> = {
      HOME: home,
      [EVAL_API_BASE_URL_ENV]: GATEWAY,
      [OPENROUTER_API_KEY_ENV]: "rk_ori_child",
    };
    applyHostProviderEnv(env);
    assert.equal(env[PI_CODING_AGENT_DIR_ENV], join(home, ".ori", "pi-agent"));
    await withHostProviderEnvironment(env, async () => {
      await ensureIsolatedOriChildAuth(env);
    });
    const credentials = JSON.parse(
      await readFile(join(home, ".ori", "credentials.json"), "utf8"),
    ) as { key: string; userId: null };
    assert.equal(credentials.key, "rk_ori_child");
    assert.equal(credentials.userId, null);
    const models = JSON.parse(
      await readFile(join(home, ".ori", "pi-agent", "models.json"), "utf8"),
    ) as { providers: { openrouter: { apiKey: string; baseUrl: string } } };
    assert.equal(models.providers.openrouter.baseUrl, `${GATEWAY}/v1`);
    assert.equal(models.providers.openrouter.apiKey, "$OPENROUTER_API_KEY");
    const auth = JSON.parse(
      await readFile(join(home, ".ori", "pi-agent", "auth.json"), "utf8"),
    ) as { openrouter: { type: string; key: string } };
    assert.equal(auth.openrouter.type, "api_key");
    assert.equal(auth.openrouter.key, "rk_ori_child");
  });
});

describe("injected provider origin in extracted production code", () => {
  test("catalog fetch uses ORI_EVAL_API_BASE_URL at call time", async () => {
    const previous = process.env[EVAL_API_BASE_URL_ENV];
    await withHostProviderEnvironment({ [EVAL_API_BASE_URL_ENV]: GATEWAY }, async () => {
      let seen = "";
      await fetchOpenRouterModels(async (url) => {
        seen = url;
        return { ok: true, json: async () => ({ data: [] }), status: 200 };
      });
      assert.equal(seen, `${GATEWAY}/v1/models?sort=top-weekly`);
    });
    assert.equal(process.env[EVAL_API_BASE_URL_ENV], previous);
  });

  test("endpoint fetch uses ORI_EVAL_API_BASE_URL at call time", async () => {
    const previous = process.env[EVAL_API_BASE_URL_ENV];
    await withHostProviderEnvironment({ [EVAL_API_BASE_URL_ENV]: GATEWAY }, async () => {
      let seen = "";
      await fetchOpenRouterModelEndpoints("openai/gpt-5.6-terra", async (url) => {
        seen = url;
        return { ok: true, json: async () => ({ data: { endpoints: [] } }), status: 200 };
      });
      assert.equal(seen, `${GATEWAY}/v1/models/openai/gpt-5.6-terra/endpoints`);
    });
    assert.equal(process.env[EVAL_API_BASE_URL_ENV], previous);
  });

  test("Claude child env follows ANTHROPIC_BASE_URL or the host origin", () => {
    const key = Redacted.make("sk-or-v1-test");
    const fromHost = buildClaudeProcessEnv(key, { [EVAL_API_BASE_URL_ENV]: GATEWAY });
    assert.equal(Redacted.value(fromHost.ANTHROPIC_BASE_URL), GATEWAY);

    const explicit = buildClaudeProcessEnv(key, {
      [ANTHROPIC_BASE_URL_ENV]: "https://api.anthropic.com",
      [EVAL_API_BASE_URL_ENV]: GATEWAY,
    });
    assert.equal(Redacted.value(explicit.ANTHROPIC_BASE_URL), "https://api.anthropic.com");

    const defaults = buildClaudeProcessEnv(key, {});
    assert.equal(Redacted.value(defaults.ANTHROPIC_BASE_URL), DEFAULT_EVAL_API_BASE_URL);
  });

  test("Pi models.json writes a host OpenAI-compatible baseUrl and leaves a user override", () => {
    return withHostProviderEnvironment({ [EVAL_API_BASE_URL_ENV]: GATEWAY }, async () => {
      const merged = mergePiModelsConfig({ existingContent: undefined, headers: [] });
      const parsed = JSON.parse(merged ?? "") as {
        providers: {
          openrouter: { apiKey: string; baseUrl: string; __oriHostApiBaseUrl: boolean };
        };
      };
      assert.equal(parsed.providers.openrouter.baseUrl, `${GATEWAY}/v1`);
      assert.equal(parsed.providers.openrouter.__oriHostApiBaseUrl, true);
      assert.equal(parsed.providers.openrouter.apiKey, "$OPENROUTER_API_KEY");
      const userOverride = JSON.parse(
        mergePiModelsConfig({
          existingContent: JSON.stringify({
            providers: { openrouter: { baseUrl: "http://user-proxy/v1" } },
          }),
          headers: [],
        }) ?? "",
      ) as { providers: { openrouter: { apiKey: string; baseUrl: string } } };
      assert.equal(userOverride.providers.openrouter.baseUrl, "http://user-proxy/v1");
      assert.equal(userOverride.providers.openrouter.apiKey, "$OPENROUTER_API_KEY");
      const hostModels = [
        { id: "openai/gpt-5.6-luna" },
        { id: "openai/gpt-5.6-terra" },
        { id: "openai/gpt-5.6-sol" },
      ];
      const kept = mergePiModelsConfig({
        env: {},
        existingContent: JSON.stringify({
          providers: {
            openrouter: {
              apiKey: "$OPENROUTER_API_KEY",
              baseUrl: "http://127.0.0.1:9/v1",
              __oriHostApiBaseUrl: true,
              compat: { supportsReasoningEffort: false },
              models: hostModels,
            },
          },
        }),
        headers: [],
      });
      assert.equal(kept, undefined);
    });
  });
});
