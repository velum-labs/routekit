import assert from "node:assert/strict";
import { test } from "node:test";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import {
  type Backend,
  borrowedBackendPorts,
  ModelRoutedBackend,
  staticBackendModelPort
} from "../backend.js";

function stubBackend(
  id: string,
  defaultModel?: string,
  wireShape?: string
): Backend & { chats: unknown[]; wireModels: string[] } {
  const chats: unknown[] = [];
  const wireModels: string[] = [];
  const backend: Backend & { chats: unknown[]; wireModels: string[] } = {
    defaultModel,
    ports: borrowedBackendPorts(defaultModel),
    chats,
    wireModels,
    chat(body: unknown) {
      chats.push(body);
      return Effect.succeed(
        new Response(JSON.stringify({ served_by: id }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    },
    models: () => Effect.succeed(new Response("{}", { status: 200 })),
    embeddings: () => Effect.succeed(new Response("{}", { status: 200 }))
  };
  backend.ports = {
    models: {
      ...staticBackendModelPort(defaultModel),
      reasoningWireShape: (model) => {
        wireModels.push(model);
        return wireShape;
      }
    },
    responses: { kind: "unsupported" },
    lifecycle: { kind: "borrowed" }
  };
  return backend;
}

test("ModelRoutedBackend dispatches by requested model id", async () => {
  const primary = stubBackend("primary", "qwen3", "openai-chat");
  const routed = stubBackend("front-door", undefined, "openai-responses");
  const backend = new ModelRoutedBackend({
    routedModelIds: ["route-primary", "route-secondary"],
    routed,
    primary
  });

  const member = (await (
    await runRouteKitEffect(backend.chat({ model: "qwen3", messages: [] }))
  ).json()) as {
    served_by: string;
  };
  assert.equal(member.served_by, "primary");
  const routedResponse = (await (
    await runRouteKitEffect(backend.chat({ model: "route-secondary", messages: [] }))
  ).json()) as { served_by: string };
  assert.equal(routedResponse.served_by, "front-door");
  // No model at all falls back to the primary (its defaultModel applies).
  const bare = (await (await runRouteKitEffect(backend.chat({ messages: [] }))).json()) as {
    served_by: string;
  };
  assert.equal(bare.served_by, "primary");

  assert.equal(backend.defaultModel, "qwen3");
  assert.deepEqual([...backend.listModelIds()], ["qwen3", "route-primary", "route-secondary"]);
  assert.equal(backend.resolveModel("route-primary"), "route-primary");
  assert.equal(backend.resolveModel("anything-else"), "qwen3");
  assert.equal(backend.ports.models.reasoningWireShape("route-secondary"), "openai-responses");
  assert.equal(backend.ports.models.reasoningWireShape("qwen3"), "openai-chat");
  assert.deepEqual(routed.wireModels, ["route-secondary"]);
  assert.deepEqual(primary.wireModels, ["qwen3"]);
});
