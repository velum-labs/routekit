import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";

import type { ProviderSource } from "../provider-source.js";
import {
  ModelCatalog,
  ModelResolver,
  ProviderLifecycle,
  RoutePlanner,
  RoutePolicy
} from "../routing-core.js";
import { testProviderSource } from "./provider-source-fixture.js";

function source(id: "openai" | "anthropic", close?: () => Promise<void>): ProviderSource {
  return testProviderSource({
    sourceId: id,
    discoverModels: () => Effect.succeed([{ id: "model" }]),
    chat: () => Effect.succeed(Response.json({})),
    embeddings: () => Effect.succeed(Response.json({})),
    ...(close !== undefined ? { close } : {})
  });
}

test("catalog, resolver, policy, and planner produce an immutable route plan", () => {
  const provider = source("openai");
  const catalog = new ModelCatalog([
    [
      "openai/model",
      {
        publicId: "openai/model",
        nativeId: "model",
        provider: "openai",
        capabilities: { tools: "true" }
      }
    ]
  ]);
  const resolver = new ModelResolver(catalog, "openai/model");
  const policy = new RoutePolicy((model) => model.startsWith("openai/"));
  const plan = new RoutePlanner(resolver).plan(undefined);

  assert.equal(policy.admit("openai/model"), true);
  assert.equal(plan?.publicModel, "openai/model");
  assert.equal(plan?.nativeModel, "model");
  assert.equal(Object.isFrozen(plan), true);
  assert.throws(() => {
    if (plan !== undefined) {
      (plan as { nativeModel: string }).nativeModel = "changed";
    }
  }, TypeError);
});

test("provider lifecycle attempts every close and aggregates cleanup failures", async () => {
  const closed: string[] = [];
  const lifecycle = new ProviderLifecycle([
    source("openai", async () => {
      closed.push("openai");
      throw new Error("openai close failed");
    }),
    source("anthropic", async () => {
      closed.push("anthropic");
    })
  ]);

  await assert.rejects(lifecycle.close(), AggregateError);
  assert.deepEqual(closed.sort(), ["anthropic", "openai"]);
});
