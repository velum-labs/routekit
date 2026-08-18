import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRouterConfig, resolveLeaderboardConfig } from "@velum-labs/routekit-config-core";
import { decodeModelDiscovery } from "@velum-labs/routekit-contracts/provider-discovery";
import { RouteKitFailure, runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import {
  anthropicRequestMetadataOf,
  attachAnthropicRequestMetadata,
  attachReasoningSelection,
  REASONING_SELECTION,
  reasoningSelectionErrorOf,
  reasoningSelectionOf,
  routeKitRequestValidationErrorOf
} from "../adapters/openai-chat-wire.js";
import type {
  BackendRequestOptions,
  DiscoveredModel,
  ProviderId,
  ProviderSource
} from "../index.js";
import {
  modelPolicyAllowsModel,
  modelPolicyRuleMatches,
  NoModelAvailableError,
  RoutingBackend,
  UnknownModelError
} from "../index.js";
import { testProviderSource } from "./provider-source-fixture.js";

function fakeSource(
  sourceId: ProviderId,
  models: readonly DiscoveredModel[],
  calls: Array<{ source: string; model?: string }> = []
): ProviderSource {
  return testProviderSource({
    sourceId,
    discoverModels: () => Effect.succeed(models),
    chat(body: unknown, _signal?: AbortSignal, _options?: BackendRequestOptions) {
      const model =
        typeof body === "object" &&
        body !== null &&
        "model" in body &&
        typeof body.model === "string"
          ? body.model
          : undefined;
      calls.push({ source: sourceId, ...(model !== undefined ? { model } : {}) });
      return Effect.succeed(Response.json({ source: sourceId, model }));
    },
    embeddings() {
      return Effect.succeed(Response.json({}));
    }
  });
}

test("RouterConfig accepts explicit provider maps and namespaced defaults", () => {
  assert.deepEqual(parseRouterConfig({ providers: {} }).providers, {});
  const config = parseRouterConfig({
    providers: {
      openai: {},
      bedrock: {},
      codex: { strategy: "round_robin", switchThreshold: 0.8 }
    },
    defaultModel: "codex/gpt-5.5",
    leaderboard: {
      liveLimit: 5000,
      liveTtlHours: 72,
      durable: true,
      durableRetentionDays: 14
    }
  });
  assert.equal(config.providers.openai?.strategy, "capacity_weighted");
  assert.equal(config.providers.bedrock?.strategy, "capacity_weighted");
  assert.equal(config.providers.codex?.strategy, "round_robin");
  assert.deepEqual(config.leaderboard, {
    liveLimit: 5000,
    liveTtlHours: 72,
    durable: true,
    durableRetentionDays: 14
  });
  assert.deepEqual(resolveLeaderboardConfig({}), {
    liveLimit: 1000,
    liveTtlHours: 24,
    durable: false,
    durableRetentionDays: 14
  });
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        leaderboard: { liveLimit: 0 }
      }),
    /liveLimit/
  );
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        defaultModel: "gpt-5.5"
      }),
    /provider\/model namespace/
  );
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        defaultModel: "codex/gpt-5.5"
      }),
    /provider "codex" is not configured/
  );
  assert.throws(() => parseRouterConfig({ endpoints: [] }), /invalid input|unrecognized key/i);
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        reasoningCapabilities: {
          "openai/opaque": {
            efforts: [{ id: "quick" }],
            defaultEffort: "missing"
          }
        }
      }),
    /default reasoning effort/
  );
});

test("model policy validates and matches anchored canonical model globs", () => {
  const parsed = parseRouterConfig({
    providers: { openai: {}, openrouter: {} },
    modelPolicy: {
      allow: ["openai/gpt-*"],
      deny: ["openrouter/*/free"]
    }
  });
  assert.deepEqual(parsed.modelPolicy, {
    allow: ["openai/gpt-*"],
    deny: ["openrouter/*/free"]
  });
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        modelPolicy: { deny: ["openai/private", "openai/private"] }
      }),
    /duplicate model policy deny rule.*openai\/private/
  );
  assert.equal(modelPolicyRuleMatches("openai/gpt-*", "openai/gpt-5.5"), true);
  assert.equal(modelPolicyRuleMatches("openai/gpt-*", "xopenai/gpt-5.5"), false);
  assert.equal(
    modelPolicyRuleMatches("openrouter/*/thinking*", "openrouter/moonshotai/kimi/k2/thinking-fast"),
    true
  );
  assert.equal(modelPolicyRuleMatches("openai/gpt.?", "openai/gpt-4"), false);
  assert.equal(modelPolicyAllowsModel(undefined, "openai/gpt-5.5"), true);
  assert.equal(modelPolicyAllowsModel({ allow: [] }, "openai/gpt-5.5"), true);
  assert.equal(
    modelPolicyAllowsModel({ allow: ["openai/*"], deny: ["openai/gpt-5.5"] }, "openai/gpt-5.5"),
    false
  );
  for (const rule of ["gpt-*", "unknown/*", "openai/", "openai//gpt"] as const) {
    assert.throws(
      () =>
        parseRouterConfig({
          providers: { openai: {} },
          modelPolicy: { allow: [rule] }
        }),
      /model policy rule.*supported provider\/model namespace/
    );
  }
});

test("already-namespaced upstream ids are not prefixed a second time", async () => {
  const calls: Array<{ source: string; model?: string }> = [];
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { openai: {} },
        defaultModel: "openai/gpt-5.6-sol"
      },
      sources: {
        openai: fakeSource("openai", [{ id: "openai/gpt-5.6-sol" }, { id: "gpt-5.5" }], calls)
      }
    })
  );
  assert.deepEqual([...backend.listModelIds()].sort(), ["openai/gpt-5.5", "openai/gpt-5.6-sol"]);
  assert.equal(backend.modelInfo("openai/gpt-5.6-sol")?.nativeModel, "openai/gpt-5.6-sol");
  assert.equal(backend.modelInfo("openai/gpt-5.5")?.nativeModel, "gpt-5.5");
  await runRouteKitEffect(backend.chat({ model: "openai/gpt-5.6-sol", messages: [] }));
  assert.deepEqual(calls, [{ source: "openai", model: "openai/gpt-5.6-sol" }]);
});

test("model policy filters every catalog-backed surface and preserves routing", async () => {
  const calls: Array<{ source: string; model?: string }> = [];
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { openai: {}, openrouter: {} },
        modelPolicy: {
          allow: ["openai/gpt-*", "openrouter/moonshotai/*"],
          deny: ["openai/gpt-private", "openrouter/*/preview"]
        },
        defaultModel: "openrouter/moonshotai/kimi/k2-thinking"
      },
      sources: {
        openai: fakeSource(
          "openai",
          [{ id: "gpt-5.5" }, { id: "gpt-private" }, { id: "embedding-3" }],
          calls
        ),
        openrouter: fakeSource(
          "openrouter",
          [{ id: "moonshotai/kimi/k2-thinking" }, { id: "moonshotai/kimi/preview" }],
          calls
        )
      }
    })
  );
  assert.deepEqual(backend.listModelIds(), [
    "openai/gpt-5.5",
    "openrouter/moonshotai/kimi/k2-thinking"
  ]);
  assert.equal(backend.servesModel("openai/gpt-private"), false);
  assert.equal(backend.resolveModel("openai/gpt-private"), undefined);
  assert.equal(backend.resolveModelRoute("gpt-private", "openai"), undefined);
  assert.equal(backend.modelInfo("openai/gpt-private"), undefined);
  assert.throws(
    () => backend.chat({ model: "openai/gpt-private", messages: [] }),
    (error: unknown) => error instanceof UnknownModelError
  );
  await runRouteKitEffect(
    backend.chat({ model: "openrouter/moonshotai/kimi/k2-thinking", messages: [] })
  );
  assert.deepEqual(calls, [{ source: "openrouter", model: "moonshotai/kimi/k2-thinking" }]);
  assert.deepEqual(await runRouteKitEffect(backend.providerStatuses()), [
    { provider: "openai", ok: true, models: ["openai/gpt-5.5"] },
    {
      provider: "openrouter",
      ok: true,
      models: ["openrouter/moonshotai/kimi/k2-thinking"]
    }
  ]);
  const response = (await (await runRouteKitEffect(backend.models())).json()) as {
    data: Array<{ id: string }>;
  };
  assert.deepEqual(
    response.data.map(({ id }) => id),
    backend.listModelIds()
  );
});

test("model policy reports excluded defaults, aliases, and empty catalogs", async () => {
  await assert.rejects(
    runRouteKitEffect(
      RoutingBackend.create({
        config: {
          providers: { openai: {} },
          modelPolicy: { deny: ["openai/private"] },
          defaultModel: "openai/private"
        },
        sources: { openai: fakeSource("openai", [{ id: "private" }, { id: "public" }]) }
      })
    ),
    /default model "openai\/private" is excluded by model policy/
  );
  await assert.rejects(
    runRouteKitEffect(
      RoutingBackend.create({
        config: {
          providers: { openai: {} },
          modelPolicy: { deny: ["openai/private"] },
          modelAliases: { private: "openai/private" }
        },
        sources: { openai: fakeSource("openai", [{ id: "private" }, { id: "public" }]) }
      })
    ),
    /model alias "private" targets "openai\/private", which is excluded by model policy/
  );
  await assert.rejects(
    runRouteKitEffect(
      RoutingBackend.create({
        config: {
          providers: { openai: {}, openrouter: {} },
          modelPolicy: { allow: ["openai/not-discovered"] }
        },
        sources: {
          openai: fakeSource("openai", [{ id: "gpt-5.5" }]),
          openrouter: fakeSource("openrouter", [{ id: "vendor/model" }])
        }
      })
    ),
    /model policy excludes all discovered models/
  );
});

test("empty provider configuration creates a credential-independent empty catalog", async () => {
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: { providers: {} },
      env: {}
    })
  );
  assert.equal(backend.defaultModel, undefined);
  assert.deepEqual(backend.listModelIds(), []);
  assert.deepEqual(await runRouteKitEffect(backend.providerStatuses()), []);
  assert.deepEqual(await (await runRouteKitEffect(backend.models())).json(), {
    object: "list",
    data: []
  });
  assert.throws(
    () => backend.chat({ messages: [] }),
    (error: unknown) => error instanceof NoModelAvailableError
  );
  assert.throws(
    () => backend.chat({ model: "openai/not-configured", messages: [] }),
    (error: unknown) =>
      error instanceof UnknownModelError && error.model === "openai/not-configured"
  );
  assert.throws(
    () => backend.embeddings({ input: "hello" }),
    (error: unknown) => error instanceof NoModelAvailableError
  );
});

test("discovery normalizes native response shapes", () => {
  assert.deepEqual(
    decodeModelDiscovery("openai", {
      data: [{ id: "gpt-5.5" }, { id: "gpt-5.5" }, { nope: true }]
    }).map((model) => model.id),
    ["gpt-5.5"]
  );
  assert.deepEqual(
    decodeModelDiscovery("anthropic", {
      data: [{ id: "claude-opus-4-1" }]
    }).map((model) => model.id),
    ["claude-opus-4-1"]
  );
  assert.deepEqual(
    decodeModelDiscovery("google", {
      models: [{ name: "models/gemini-2.5-pro" }]
    }).map((model) => model.id),
    ["gemini-2.5-pro"]
  );
  assert.deepEqual(
    decodeModelDiscovery(
      "codex",
      {
        models: [
          {
            slug: "gpt-5.5",
            default_reasoning_level: "balanced",
            supported_reasoning_levels: [
              { effort: "quick", description: "Quick" },
              { effort: "balanced", description: "Balanced" }
            ]
          }
        ]
      },
      { provider: "codex" }
    ).map((model) => model.id),
    ["gpt-5.5"]
  );
  const reasoning = decodeModelDiscovery(
    "codex",
    {
      models: [
        {
          slug: "opaque",
          default_reasoning_level: "balanced",
          supported_reasoning_levels: ["quick", "balanced"]
        }
      ]
    },
    { provider: "codex" }
  )[0]?.reasoning;
  assert.deepEqual(reasoning?.efforts, [{ id: "quick" }, { id: "balanced" }]);
  assert.equal(reasoning?.defaultEffort, "balanced");
  assert.equal(reasoning?.wireShape, "openai-responses");
  assert.equal(reasoning?.provenance, "provider");
  assert.throws(() => decodeModelDiscovery("openai", { data: [] }), /no usable openai models/);
});
test("catalog namespaces live models and strips the source before dispatch", async () => {
  const calls: Array<{ source: string; model?: string }> = [];
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { openai: {}, openrouter: {} },
        defaultModel: "openrouter/moonshotai/kimi-k2-thinking"
      },
      sources: {
        openai: fakeSource("openai", [{ id: "gpt-5.5" }], calls),
        openrouter: fakeSource("openrouter", [{ id: "moonshotai/kimi-k2-thinking" }], calls)
      }
    })
  );

  assert.deepEqual(backend.listModelIds(), [
    "openai/gpt-5.5",
    "openrouter/moonshotai/kimi-k2-thinking"
  ]);
  assert.deepEqual(backend.resolveModelRoute("gpt-5.5", "openai"), {
    publicId: "openai/gpt-5.5",
    nativeId: "gpt-5.5",
    provider: "openai",
    reasoning: backend.reasoningCapabilities("openai/gpt-5.5")
  });
  assert.equal(
    backend.resolveModelRoute("gpt-5.5"),
    undefined,
    "bare ids remain invalid without a native-provider scope"
  );
  assert.deepEqual(
    backend.resolveModelRoute("openrouter/moonshotai/kimi-k2-thinking", "openai"),
    {
      publicId: "openrouter/moonshotai/kimi-k2-thinking",
      nativeId: "moonshotai/kimi-k2-thinking",
      provider: "openrouter"
    },
    "an exact canonical id wins even on a native client door"
  );
  await runRouteKitEffect(backend.chat({ messages: [] }));
  await runRouteKitEffect(backend.chat({ model: "openai/gpt-5.5", messages: [] }));
  assert.deepEqual(calls, [
    { source: "openrouter", model: "moonshotai/kimi-k2-thinking" },
    { source: "openai", model: "gpt-5.5" }
  ]);

  const models = (await (await runRouteKitEffect(backend.models())).json()) as {
    data: Array<{ id: string; owned_by: string }>;
  };
  assert.deepEqual(
    models.data.map((model) => [model.id, model.owned_by]),
    [
      ["openai/gpt-5.5", "openai"],
      ["openrouter/moonshotai/kimi-k2-thinking", "openrouter"]
    ]
  );
  assert.deepEqual(backend.modelInfo("openai/gpt-5.5"), {
    id: "openai/gpt-5.5",
    provider: "openai",
    nativeModel: "gpt-5.5",
    accountClass: "api-key",
    billingMode: "metered-api",
    default: false,
    capabilities: {},
    reasoning: {
      status: "supported",
      efforts: ["none", "low", "medium", "high", "xhigh"].map((id) => ({ id })),
      wireShape: "openai-chat",
      provenance: "builtin"
    }
  });
  assert.equal(backend.modelInfo("openai/not-real"), undefined);
});

test("catalog serializes OpenRouter-compatible capability metadata additively", async () => {
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: { providers: { openrouter: {} } },
      sources: {
        openrouter: fakeSource("openrouter", [
          {
            id: "vendor/generation",
            createdAt: 200,
            providerPriority: 3,
            metadata: {
              architecture: {
                modality: "text->text",
                inputModalities: ["text"],
                outputModalities: ["text"]
              },
              supportedParameters: ["tools", "tool_choice"],
              provenance: "provider"
            }
          }
        ])
      }
    })
  );
  const payload = (await (await runRouteKitEffect(backend.models())).json()) as {
    data: Array<Record<string, unknown>>;
  };
  assert.deepEqual(payload.data[0], {
    id: "openrouter/vendor/generation",
    object: "model",
    owned_by: "openrouter",
    capabilities: {},
    created: 200,
    routekit_provider_priority: 3,
    architecture: {
      modality: "text->text",
      input_modalities: ["text"],
      output_modalities: ["text"]
    },
    supported_parameters: ["tools", "tool_choice"]
  });
});

test("catalog infers verified OpenAI gpt-5.5 reasoning controls and honors precedence", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: { providers: { openai: {} }, defaultModel: "openai/gpt-5.5" },
      sources: {
        openai: {
          ...fakeSource("openai", [{ id: "gpt-5.5" }]),
          requests: {
            chat(body: unknown) {
              bodies.push(body as Record<string, unknown>);
              return Effect.succeed(Response.json({}));
            },
            embeddings() {
              return Effect.succeed(Response.json({}));
            }
          }
        }
      }
    })
  );
  assert.deepEqual(
    backend.reasoningCapabilities("openai/gpt-5.5")?.efforts?.map((effort) => effort.id),
    ["none", "low", "medium", "high", "xhigh"]
  );
  assert.equal(backend.reasoningCapabilities("openai/gpt-5.5")?.provenance, "builtin");
  const models = (await (await runRouteKitEffect(backend.models())).json()) as {
    data: Array<{ reasoning?: { efforts?: Array<{ id: string }> } }>;
  };
  assert.deepEqual(
    models.data[0]?.reasoning?.efforts?.map((effort) => effort.id),
    ["none", "low", "medium", "high", "xhigh"]
  );
  for (const effort of ["none", "low", "medium", "high", "xhigh"]) {
    assert.equal(
      (
        await runRouteKitEffect(
          backend.chat({ model: "openai/gpt-5.5", reasoning_effort: effort, messages: [] })
        )
      ).status,
      200
    );
  }
  for (const effort of ["minimal", "max"]) {
    assert.equal(
      (
        await runRouteKitEffect(
          backend.chat({ model: "openai/gpt-5.5", reasoning_effort: effort, messages: [] })
        )
      ).status,
      400
    );
  }
  assert.deepEqual(
    bodies.map((body) => body.reasoning_effort),
    ["none", "low", "medium", "high", "xhigh"]
  );

  const providerMetadata = await runRouteKitEffect(
    RoutingBackend.create({
      config: { providers: { openai: {} } },
      sources: {
        openai: fakeSource("openai", [
          {
            id: "gpt-5.5",
            reasoning: {
              status: "supported",
              efforts: [{ id: "provider-only" }],
              provenance: "provider"
            }
          }
        ])
      }
    })
  );
  assert.deepEqual(providerMetadata.reasoningCapabilities("openai/gpt-5.5")?.efforts, [
    { id: "provider-only" }
  ]);
});

test("configured model aliases serve namespaced models under slash-free names", async () => {
  const calls: Array<{ source: string; model?: string }> = [];
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { "claude-code": {} },
        modelAliases: { "velum-fable-5": "claude-code/claude-fable-5" }
      },
      sources: {
        "claude-code": fakeSource(
          "claude-code",
          [{ id: "claude-fable-5", createdAt: 200, providerPriority: 1 }],
          calls
        )
      }
    })
  );

  assert.deepEqual(backend.listModelIds(), ["claude-code/claude-fable-5", "velum-fable-5"]);
  assert.equal(backend.servesModel("velum-fable-5"), true);
  assert.deepEqual(backend.resolveModelRoute("velum-fable-5"), {
    publicId: "velum-fable-5",
    nativeId: "claude-fable-5",
    provider: "claude-code"
  });
  assert.equal(backend.modelInfo("velum-fable-5")?.id, "velum-fable-5");
  assert.equal(backend.modelInfo("velum-fable-5")?.nativeModel, "claude-fable-5");
  assert.equal(backend.modelInfo("velum-fable-5")?.createdAt, 200);
  assert.equal(backend.modelInfo("velum-fable-5")?.providerPriority, 1);
  await runRouteKitEffect(backend.chat({ model: "velum-fable-5", messages: [] }));
  assert.deepEqual(calls, [{ source: "claude-code", model: "claude-fable-5" }]);
});

test("model aliases reject bad shapes and unknown targets", async () => {
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        modelAliases: { "bad/alias": "openai/gpt-5.5" }
      }),
    /must not contain "\/"/
  );
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        modelAliases: { "velum-fable-5": "claude-code/claude-fable-5" }
      }),
    /provider "claude-code" is not configured/
  );
  await assert.rejects(
    runRouteKitEffect(
      RoutingBackend.create({
        config: {
          providers: { openai: {} },
          modelAliases: { "velum-gpt": "openai/not-discovered" }
        },
        sources: { openai: fakeSource("openai", [{ id: "gpt-5.5" }]) }
      })
    ),
    /targets "openai\/not-discovered", which no configured provider serves/
  );
  await assert.rejects(
    runRouteKitEffect(
      RoutingBackend.create({
        config: {
          providers: { openai: {} },
          modelAliases: { "openai/gpt-5.5": "openai/gpt-5.5" }
        },
        sources: { openai: fakeSource("openai", [{ id: "gpt-5.5" }]) }
      })
    ),
    /must not contain "\/"/
  );
});

test("model info exhaustively classifies subscription and proxy billing", async () => {
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { codex: {}, "claude-code": {}, cliproxy: {} },
        defaultModel: "codex/gpt-5.5"
      },
      sources: {
        codex: fakeSource("codex", [
          {
            id: "gpt-5.5",
            capabilities: { tools: "supported" },
            reasoning: {
              status: "supported",
              efforts: [{ id: "high" }],
              provenance: "provider",
              refreshedAt: "2026-07-22T00:00:00.000Z"
            }
          }
        ]),
        "claude-code": fakeSource("claude-code", [{ id: "claude-opus-4-1" }]),
        cliproxy: fakeSource("cliproxy", [{ id: "local-route" }])
      }
    })
  );
  assert.deepEqual(backend.modelInfo("codex/gpt-5.5"), {
    id: "codex/gpt-5.5",
    provider: "codex",
    nativeModel: "gpt-5.5",
    accountClass: "subscription",
    billingMode: "subscription",
    default: true,
    capabilities: { tools: "supported" },
    reasoning: {
      status: "supported",
      efforts: [{ id: "high" }],
      provenance: "provider",
      refreshedAt: "2026-07-22T00:00:00.000Z"
    }
  });
  assert.deepEqual(
    {
      accountClass: backend.modelInfo("claude-code/claude-opus-4-1")?.accountClass,
      billingMode: backend.modelInfo("claude-code/claude-opus-4-1")?.billingMode
    },
    { accountClass: "subscription", billingMode: "subscription" }
  );
  assert.deepEqual(
    {
      accountClass: backend.modelInfo("cliproxy/local-route")?.accountClass,
      billingMode: backend.modelInfo("cliproxy/local-route")?.billingMode
    },
    { accountClass: "proxy", billingMode: "upstream-managed" }
  );
  await runRouteKitEffect(backend.close());
});

test("cliproxy routes are attributed as subscription billing", async () => {
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { cliproxy: {} },
        defaultModel: "cliproxy/gpt-test"
      },
      sources: {
        cliproxy: fakeSource("cliproxy", [{ id: "gpt-test" }])
      }
    })
  );
  const updates: unknown[] = [];
  const response = await runRouteKitEffect(
    backend.chat({ model: "cliproxy/gpt-test", messages: [] }, undefined, {
      onAttribution: (update) => updates.push(update)
    })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(updates, [
    {
      effective_model: "cliproxy/gpt-test",
      native_model: "gpt-test",
      provider: "cliproxy",
      billing_mode: "subscription"
    }
  ]);
});

test("catalog applies configured opaque efforts and rejects unavailable values before egress", async () => {
  const calls: Array<{ source: string; model?: string }> = [];
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { openai: {} },
        defaultModel: "openai/opaque",
        reasoningCapabilities: {
          "openai/opaque": {
            efforts: [{ id: "balanced", aliases: ["cursor-balanced"] }, { id: "deep" }],
            defaultEffort: "balanced",
            wireShape: "openai-chat"
          }
        }
      },
      sources: {
        openai: fakeSource("openai", [{ id: "opaque" }], calls)
      }
    })
  );
  const accepted = await runRouteKitEffect(
    backend.chat({
      model: "openai/opaque",
      reasoning_effort: "cursor-balanced",
      messages: []
    })
  );
  assert.equal(accepted.status, 200);
  const rejected = await runRouteKitEffect(
    backend.chat({
      model: "openai/opaque",
      reasoning_effort: "maximum",
      messages: []
    })
  );
  assert.equal(rejected.status, 400);
  const malformed = await runRouteKitEffect(
    backend.chat({
      model: "openai/opaque",
      reasoning_effort: 7,
      messages: []
    })
  );
  assert.equal(malformed.status, 400);
  assert.equal(calls.length, 1);
  assert.equal(backend.reasoningCapabilities("openai/opaque")?.provenance, "config");
});

test("catalog lets native Claude requests forward provider-owned opaque efforts", async () => {
  const bodies: Array<Record<PropertyKey, unknown>> = [];
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { "claude-code": {} },
        defaultModel: "claude-code/claude-native",
        reasoningCapabilities: {
          "claude-code/claude-native": {
            efforts: [{ id: "quick" }, { id: "high" }],
            defaultEffort: "quick",
            wireShape: "anthropic"
          }
        }
      },
      sources: {
        "claude-code": testProviderSource({
          sourceId: "claude-code",
          discoverModels: () => Effect.succeed([{ id: "claude-native" }]),
          chat(body: unknown) {
            bodies.push(body as Record<PropertyKey, unknown>);
            return Effect.succeed(Response.json({ ok: true }));
          },
          embeddings() {
            return Effect.succeed(Response.json({}));
          }
        })
      }
    })
  );
  const request: Record<PropertyKey, unknown> = {
    model: "claude-code/claude-native",
    messages: []
  };
  attachReasoningSelection(request, {
    mode: "effort",
    effort: "provider-new-effort"
  });
  attachAnthropicRequestMetadata(request, {
    thinking: { type: "adaptive" },
    output_config: { effort: "provider-new-effort" }
  });

  const response = await runRouteKitEffect(backend.chat(request));

  assert.equal(response.status, 200);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.reasoning_effort, "provider-new-effort");
  assert.deepEqual(reasoningSelectionOf(bodies[0]), {
    mode: "effort",
    effort: "provider-new-effort"
  });
});

test("catalog keeps Anthropic metadata aligned when resolving effort aliases", async () => {
  const bodies: Array<Record<PropertyKey, unknown>> = [];
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { openai: {} },
        defaultModel: "openai/opaque",
        reasoningCapabilities: {
          "openai/opaque": {
            efforts: [{ id: "quick", aliases: ["high"] }],
            defaultEffort: "quick",
            wireShape: "openai-chat"
          }
        }
      },
      sources: {
        openai: testProviderSource({
          sourceId: "openai",
          discoverModels: () => Effect.succeed([{ id: "opaque" }]),
          chat(body: unknown) {
            bodies.push(body as Record<PropertyKey, unknown>);
            return Effect.succeed(Response.json({ ok: true }));
          },
          embeddings() {
            return Effect.succeed(Response.json({}));
          }
        })
      }
    })
  );
  const request: Record<PropertyKey, unknown> = {
    model: "openai/opaque",
    messages: []
  };
  attachReasoningSelection(request, { mode: "effort", effort: "high" });
  attachAnthropicRequestMetadata(request, {
    thinking: { type: "adaptive" },
    output_config: { effort: "high" }
  });

  const response = await runRouteKitEffect(backend.chat(request));

  assert.equal(response.status, 200);
  assert.equal(bodies.length, 1);
  assert.deepEqual(reasoningSelectionOf(bodies[0]), { mode: "effort", effort: "quick" });
  assert.equal(anthropicRequestMetadataOf(bodies[0])?.output_config?.effort, "quick");
  assert.equal(routeKitRequestValidationErrorOf(bodies[0]), undefined);
});

test("catalog treats Codex none as disabled only for models without reasoning controls", async () => {
  const exercise = async (
    reasoning: DiscoveredModel["reasoning"],
    effort: string
  ): Promise<{ response: Response; bodies: Array<Record<string, unknown>> }> => {
    const bodies: Array<Record<string, unknown>> = [];
    const backend = await runRouteKitEffect(
      RoutingBackend.create({
        config: {
          providers: { openai: {} },
          defaultModel: "openai/model"
        },
        sources: {
          openai: testProviderSource({
            sourceId: "openai",
            discoverModels: () =>
              Effect.succeed([{ id: "model", ...(reasoning !== undefined ? { reasoning } : {}) }]),
            chat(body: unknown) {
              bodies.push(body as Record<string, unknown>);
              return Effect.succeed(Response.json({}));
            },
            embeddings() {
              return Effect.succeed(Response.json({}));
            }
          })
        }
      })
    );
    return {
      response: await runRouteKitEffect(
        backend.chat({
          model: "openai/model",
          reasoning_effort: effort,
          messages: []
        })
      ),
      bodies
    };
  };

  for (const reasoning of [
    undefined,
    { status: "unknown", provenance: "unknown" } as const,
    { status: "unsupported", provenance: "provider" } as const
  ]) {
    const normalized = await exercise(reasoning, "none");
    assert.equal(normalized.response.status, 200);
    assert.equal(normalized.bodies.length, 1);
    assert.equal(normalized.bodies[0]?.reasoning_effort, undefined);
  }

  const undiscoveredEffort = await exercise(undefined, "medium");
  assert.equal(undiscoveredEffort.response.status, 400);
  assert.equal(undiscoveredEffort.bodies.length, 0);

  const advertisedNone = await exercise(
    {
      status: "supported",
      efforts: [{ id: "none" }, { id: "high" }],
      provenance: "provider"
    },
    "none"
  );
  assert.equal(advertisedNone.response.status, 200);
  assert.equal(advertisedNone.bodies[0]?.reasoning_effort, "none");

  const unsupportedNone = await exercise(
    {
      status: "supported",
      efforts: [{ id: "low" }, { id: "high" }],
      provenance: "provider"
    },
    "none"
  );
  assert.equal(unsupportedNone.response.status, 400);
  assert.equal(unsupportedNone.bodies.length, 0);
});

test("unknown models never fall through to the default source", async () => {
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: { providers: { openai: {} } },
      sources: { openai: fakeSource("openai", [{ id: "gpt-5.5" }]) }
    })
  );
  assert.throws(
    () => backend.chat({ model: "openai/not-real", messages: [] }),
    (error: unknown) => error instanceof UnknownModelError && error.model === "openai/not-real"
  );
});

test("startup reports provider-specific discovery and credential failures", async () => {
  await assert.rejects(
    runRouteKitEffect(
      RoutingBackend.create({
        config: { providers: { openai: {} } },
        sources: {
          openai: {
            ...fakeSource("openai", []),
            discovery: {
              discoverModels: () => new RouteKitFailure({ message: "bad token" })
            }
          }
        }
      })
    ),
    /provider "openai" discovery failed: bad token/
  );
  await assert.rejects(
    runRouteKitEffect(
      RoutingBackend.create({
        config: { providers: { openai: {} } },
        env: {}
      })
    ),
    /provider "openai" is missing credential environment variable OPENAI_API_KEY/
  );
  await assert.rejects(
    runRouteKitEffect(
      RoutingBackend.create({
        config: { providers: { codex: {} } }
      })
    ),
    /provider "codex" requires enrolled subscription accounts/
  );
});

test("startup attempts every provider finalizer and aggregates cleanup failures", async () => {
  const events: string[] = [];
  const discoveryError = new Error("anthropic discovery failed");
  const openaiCloseError = new Error("openai close failed");
  const anthropicCloseError = new Error("anthropic close failed");
  const openai = {
    ...fakeSource("openai", [{ id: "gpt-5.5" }]),
    resource: {
      kind: "owned" as const,
      close: Effect.sync(() => {
        events.push("close:openai");
        throw openaiCloseError;
      })
    }
  };
  const anthropic = {
    ...fakeSource("anthropic", []),
    discovery: {
      discoverModels: () => Effect.fail(discoveryError)
    },
    resource: {
      kind: "owned" as const,
      close: Effect.sync(() => {
        events.push("close:anthropic");
        throw anthropicCloseError;
      })
    }
  };

  await assert.rejects(
    runRouteKitEffect(
      RoutingBackend.create({
        config: { providers: { openai: {}, anthropic: {} } },
        sources: { openai, anthropic }
      })
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 3);
      assert.match(String(error.errors[0]), /anthropic discovery failed/);
      assert.equal((error.errors[0] as Error).cause, discoveryError);
      assert.equal(error.errors[1], anthropicCloseError);
      assert.equal(error.errors[2], openaiCloseError);
      return true;
    }
  );
  assert.deepEqual(events, ["close:anthropic", "close:openai"]);
});

test("reasoning selection validation rejects malformed public and internal metadata", async () => {
  const valid = [
    { mode: "auto" },
    { mode: "disabled" },
    { mode: "adaptive" },
    { mode: "effort", effort: "high" },
    { mode: "budget", budgetTokens: 2048 }
  ] as const;
  for (const selection of valid) {
    const body = { x_routekit: { version: 1, selection } };
    assert.equal(reasoningSelectionErrorOf(body), undefined);
    assert.deepEqual(reasoningSelectionOf(body), selection);
  }

  const invalid: Array<[unknown, RegExp]> = [
    [{ mode: "future" }, /mode is unsupported/],
    [{ mode: "effort" }, /effort must be a non-empty string/],
    [{ mode: "effort", effort: "" }, /effort must be a non-empty string/],
    [{ mode: "budget", budgetTokens: 1.5 }, /budgetTokens must be a positive integer/],
    [{ mode: "budget", budgetTokens: 0 }, /budgetTokens must be a positive integer/],
    [[{ mode: "auto" }], /must be an object/]
  ];
  for (const [selection, expected] of invalid) {
    const publicBody = { x_routekit: { version: 1, selection } };
    assert.match(reasoningSelectionErrorOf(publicBody) ?? "", expected);
    assert.deepEqual(reasoningSelectionOf(publicBody), { mode: "auto" });
    const internalBody: Record<PropertyKey, unknown> = {};
    Object.defineProperty(internalBody, REASONING_SELECTION, {
      value: selection,
      enumerable: true
    });
    assert.match(reasoningSelectionErrorOf(internalBody) ?? "", expected);
    assert.deepEqual(reasoningSelectionOf(internalBody), { mode: "auto" });
  }
  assert.equal(reasoningSelectionErrorOf({ x_routekit: [] }), "x_routekit must be an object");
  assert.deepEqual(reasoningSelectionOf({ x_routekit: [] }), { mode: "auto" });

  const calls: Array<{ source: string; model?: string }> = [];
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { openai: {} },
        defaultModel: "openai/opaque",
        reasoningCapabilities: {
          "openai/opaque": {
            efforts: [{ id: "high" }],
            budget: { minTokens: 1, maxTokens: 100_000 },
            adaptive: true,
            wireShape: "openrouter"
          }
        }
      },
      sources: { openai: fakeSource("openai", [{ id: "opaque" }], calls) }
    })
  );
  for (const [selection, expected] of invalid.slice(0, 5)) {
    const response = await runRouteKitEffect(
      backend.chat({
        model: "openai/opaque",
        messages: [],
        x_routekit: { version: 1, selection }
      })
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "invalid_reasoning_control");
    assert.match(body.error.message, expected);
  }
  assert.equal(calls.length, 0, "malformed public metadata must never reach provider I/O");
});

test("Bedrock models use canonical ids and API-key billing attribution", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: { providers: { bedrock: {} }, defaultModel: "bedrock/us.anthropic.claude-3" },
      sources: {
        bedrock: {
          ...fakeSource("bedrock", [{ id: "us.anthropic.claude-3" }]),
          requests: {
            chat() {
              return Effect.succeed(Response.json({ ok: true }));
            },
            embeddings() {
              return Effect.succeed(Response.json({}));
            }
          }
        }
      }
    })
  );
  assert.deepEqual(backend.listModelIds(), ["bedrock/us.anthropic.claude-3"]);
  assert.deepEqual(backend.modelInfo("bedrock/us.anthropic.claude-3"), {
    id: "bedrock/us.anthropic.claude-3",
    provider: "bedrock",
    nativeModel: "us.anthropic.claude-3",
    accountClass: "api-key",
    billingMode: "metered-api",
    default: true,
    capabilities: {},
    reasoning: null
  });
  await runRouteKitEffect(
    backend.chat({ model: "bedrock/us.anthropic.claude-3", messages: [] }, undefined, {
      onAttribution: (update) => updates.push(update)
    })
  );
  assert.deepEqual(updates, [
    {
      effective_model: "bedrock/us.anthropic.claude-3",
      native_model: "us.anthropic.claude-3",
      provider: "bedrock",
      billing_mode: "api_key"
    }
  ]);
});

test("Bedrock Opus 5 exposes reasoning controls and accepts routed effort selections", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { bedrock: {} },
        defaultModel: "bedrock/anthropic.claude-opus-5"
      },
      sources: {
        bedrock: {
          ...fakeSource("bedrock", [
            {
              id: "anthropic.claude-opus-5",
              reasoning: {
                status: "supported",
                efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
                adaptive: true,
                wireShape: "bedrock-converse",
                provenance: "builtin"
              }
            }
          ]),
          requests: {
            chat(body: unknown) {
              bodies.push(body as Record<string, unknown>);
              return Effect.succeed(Response.json({ ok: true }));
            },
            embeddings() {
              return Effect.succeed(Response.json({}));
            }
          }
        }
      }
    })
  );

  const models = (await (await runRouteKitEffect(backend.models())).json()) as {
    data: Array<{ id: string; reasoning?: { status?: string; efforts?: Array<{ id: string }> } }>;
  };
  assert.deepEqual(models.data[0]?.reasoning, {
    status: "supported",
    efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
    adaptive: true,
    wireShape: "bedrock-converse",
    provenance: "builtin"
  });

  const accepted = await runRouteKitEffect(
    backend.chat({
      model: "bedrock/anthropic.claude-opus-5",
      messages: [],
      reasoning_effort: "high"
    })
  );
  assert.equal(accepted.status, 200);
  assert.equal(bodies[0]?.model, "anthropic.claude-opus-5");
  assert.deepEqual(bodies[0]?.x_routekit, {
    version: 1,
    selection: { mode: "effort", effort: "high" }
  });

  const rejected = await runRouteKitEffect(
    backend.chat({
      model: "bedrock/anthropic.claude-opus-5",
      messages: [],
      reasoning_effort: "minimal"
    })
  );
  assert.equal(rejected.status, 400);
  const error = (await rejected.json()) as { error: { code: string } };
  assert.equal(error.error.code, "unsupported_reasoning_control");
});
