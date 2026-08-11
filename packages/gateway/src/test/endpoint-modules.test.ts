import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { AnthropicMessagesEndpoint } from "../endpoints/anthropic-messages-endpoint.js";
import { ChatEndpoint } from "../endpoints/chat-endpoint.js";
import type { EndpointContext } from "../endpoints/endpoint-module.js";
import { ModelsEndpoint } from "../endpoints/models-endpoint.js";
import { ResponsesEndpoint } from "../endpoints/responses-endpoint.js";
import { UsageEndpoint } from "../endpoints/usage-endpoint.js";

function context(method: string, path: string): EndpointContext {
  return {
    request: { headers: {} } as IncomingMessage,
    response: {} as ServerResponse,
    method,
    url: new URL(path, "http://localhost")
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
  const execute = async (request: { operation: string }): Promise<void> => {
    executed.push(request.operation);
  };
  const backend = {
    defaultModel: "test/model",
    chat: async () => Response.json({ choices: [] }),
    embeddings: async () => Response.json({ data: [] }),
    models: async () => Response.json({ data: [] })
  };
  const chatDependencies = {
    backend,
    readBody: async () => ({ messages: [{ role: "user", content: "hello" }] }),
    writeJson: () => {},
    rejectInvalid: () => false,
    dispatch: async (_context: EndpointContext, call: { dialect: string }) => {
      executed.push(
        call.dialect === "openai-embeddings"
          ? "embeddings"
          : "chat"
      );
    },
    attribution: () => ({})
  };
  const modelDependencies = (
    operation: string,
    models = [{ id: "test/model" }]
  ) => ({
    backend,
    anthropicRelayAvailable: false,
    includeCodexNativeModels: false,
    configuredAnthropicCatalog: () => Response.json({ data: [] }),
    pickerModels: () => {
      if (operation === "catalog") executed.push(operation);
      return [];
    },
    resolveRetrieval: () => {
      executed.push(operation);
      return { status: "ok" as const, displayName: "model" };
    },
    writeJson: () => {
      if (operation === "cursor-catalog") executed.push(operation);
    },
    pipe: async () => {},
    ...(models.length > 0
      ? {
          backend: {
            ...backend,
            models: async () => Response.json({ data: models })
          }
        }
      : {})
  });
  const anthropicDependencies = (operation: string) => ({
    backend,
    readBody: async () => ({
      model: "test/model",
      messages: [{ role: "user", content: "hello" }]
    }),
    writeJson: () => {},
    rejectInvalid: () => false,
    pipe: async () => {
      executed.push(operation);
    },
    dispatch: async () => {
      executed.push(operation);
    },
    attribution: () => ({})
  });
  const responsesDependencies = {
    backend,
    readBody: async () => ({ input: "hello", model: "test/model" }),
    rejectInvalid: () => false,
    dispatch: async () => {
      executed.push("responses");
    },
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
      new ChatEndpoint(
        authenticate,
        {
          ...chatDependencies,
          readBody: async () => ({ messages: [{ role: "user", content: "hello" }] }),
          dispatch: async () => {
            executed.push("cursor-chat");
          }
        },
        observe
      ),
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
      new AnthropicMessagesEndpoint(
        authenticate,
        anthropicDependencies("count-tokens"),
        observe
      ),
      "POST",
      "/v1/messages/count_tokens",
      "count-tokens"
    ],
    [
      new UsageEndpoint(authenticate, () => ({ ok: true }), () => {}, observe),
      "GET",
      "/usage",
      "usage"
    ]
  ] as const;

  for (const [endpoint, method, path, operation] of cases) {
    assert.equal(endpoint.matches(method, path), true);
    await endpoint.handle(context(method, path));
  }
  assert.deepEqual(executed, cases.slice(0, -1).map(([, , , operation]) => operation));
  assert.equal(authenticated.length, cases.length);
  assert.deepEqual(
    observed,
    cases.map(([endpoint, , , operation]) => `${endpoint.name}:${operation}`)
  );
});
