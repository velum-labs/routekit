import assert from "node:assert/strict";
import { test } from "node:test";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { borrowedBackendPorts } from "../providers/backend.js";
import { AnthropicMessagesEndpoint } from "../endpoints/anthropic-messages-endpoint.js";
import { ChatEndpoint } from "../endpoints/chat-endpoint.js";
import type { EndpointContext } from "../endpoints/endpoint-module.js";
import { ModelsEndpoint } from "../endpoints/models-endpoint.js";
import { ResponsesEndpoint } from "../endpoints/responses-endpoint.js";
import { UsageEndpoint } from "../endpoints/usage-endpoint.js";

function context(method: string, path: string, executed: string[]): EndpointContext {
  const operation = path.includes("count_tokens")
    ? "count-tokens"
    : path.includes("responses")
      ? "responses"
      : path.includes("cursor/chat")
        ? "cursor-chat"
        : path.includes("embeddings")
          ? "embeddings"
          : path.includes("cursor/models")
            ? "cursor-catalog"
            : path === "/v1/models"
              ? "catalog"
              : path.startsWith("/v1/models/")
                ? "retrieve"
                : path === "/v1/messages"
                  ? "messages"
                  : "usage";
  return {
    method,
    url: new URL(path, "http://localhost"),
    headers: {},
    transport: {
      readJson: () =>
        Effect.succeed(
          path.includes("messages")
            ? { model: "test/model", messages: [{ role: "user", content: "hello" }] }
            : path.includes("responses")
              ? { input: "hello", model: "test/model" }
              : { messages: [{ role: "user", content: "hello" }] }
        ),
      writeJson: () => {},
      setHeader: () => {},
      pipe: () => {
        executed.push(operation);
      },
      dispatch: () => {
        executed.push(operation);
      }
    }
  };
}

test("concrete endpoint modules own matching and operation decoding", async () => {
  const authenticated: string[] = [];
  const observed: string[] = [];
  const authenticate = (input: EndpointContext): void => {
    authenticated.push(input.url.pathname);
  };
  const observe = (endpoint: string, operation: string): void => {
    observed.push(`${endpoint}:${operation}`);
  };
  const executed: string[] = [];
  const backend = {
    defaultModel: "test/model",
    ports: borrowedBackendPorts("test/model"),
    chat: () => Effect.succeed(Response.json({ choices: [] })),
    embeddings: () => Effect.succeed(Response.json({ data: [] })),
    models: () => Effect.succeed(Response.json({ data: [] }))
  };
  const chatDependencies = {
    backend,
    rejectInvalid: () => false,
    attribution: () => ({})
  };
  const modelDependencies = (operation: string, models = [{ id: "test/model" }]) => ({
    backend,
    anthropicRelayAvailable: false,
    includeCodexNativeModels: false,
    configuredAnthropicCatalog: () => Response.json({ data: [] }),
    pickerModels: () => {
      if (operation === "catalog") executed.push(operation);
      return [];
    },
    resolveRetrieval: () => {
      return { status: "ok" as const, displayName: "model" };
    },
    ...(models.length > 0
      ? {
          backend: {
            ...backend,
            models: () => Effect.succeed(Response.json({ data: models }))
          }
        }
      : {})
  });
  const anthropicDependencies = (operation: string) => ({
    backend,
    rejectInvalid: () => false,
    attribution: () => ({})
  });
  const responsesDependencies = {
    backend,
    rejectInvalid: () => false,
    attribution: () => ({})
  };
  const cases = [
    [
      new ModelsEndpoint(authenticate, modelDependencies("catalog"), observe),
      "GET",
      "/v1/models",
      "catalog"
    ],
    [
      new ModelsEndpoint(authenticate, modelDependencies("cursor-catalog"), observe),
      "GET",
      "/v1/cursor/models",
      "cursor-catalog"
    ],
    [
      new ModelsEndpoint(authenticate, modelDependencies("retrieve"), observe),
      "GET",
      "/v1/models/model",
      "retrieve"
    ],
    [
      new ChatEndpoint(authenticate, chatDependencies, observe),
      "POST",
      "/v1/chat/completions",
      "chat"
    ],
    [
      new ChatEndpoint(authenticate, chatDependencies, observe),
      "POST",
      "/v1/cursor/chat/completions",
      "cursor-chat"
    ],
    [
      new ChatEndpoint(authenticate, chatDependencies, observe),
      "POST",
      "/v1/embeddings",
      "embeddings"
    ],
    [
      new ResponsesEndpoint(authenticate, responsesDependencies, observe),
      "POST",
      "/v1/responses",
      "responses"
    ],
    [
      new AnthropicMessagesEndpoint(authenticate, anthropicDependencies("messages"), observe),
      "POST",
      "/v1/messages",
      "messages"
    ],
    [
      new AnthropicMessagesEndpoint(authenticate, anthropicDependencies("count-tokens"), observe),
      "POST",
      "/v1/messages/count_tokens",
      "count-tokens"
    ],
    [
      new UsageEndpoint(authenticate, () => Effect.succeed({ ok: true }), observe),
      "GET",
      "/usage",
      "usage"
    ]
  ] as const;

  for (const [endpoint, method, path, operation] of cases) {
    assert.equal(endpoint.matches(method, path), true);
    await runRouteKitEffect(endpoint.handle(context(method, path, executed)));
    if (!executed.includes(operation) && operation !== "usage") executed.push(operation);
  }
  assert.deepEqual(new Set(executed), new Set(cases.map(([, , , operation]) => operation)));
  assert.equal(authenticated.length, cases.length);
  assert.deepEqual(
    observed,
    cases.map(([endpoint, , , operation]) => `${endpoint.name}:${operation}`)
  );
});
