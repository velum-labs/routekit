import assert from "node:assert/strict";
import { test } from "node:test";

import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import {
  OpenRouterModelMetadataClient,
  resolveCodexStartupModel
} from "../codex-model-selection.js";

function catalog(data: unknown[]): Response {
  return Response.json({ data });
}

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function acceptJson(init?: RequestInit): boolean {
  return new Headers(init?.headers).get("accept") === "application/json";
}

test("OpenRouter metadata classifies generation and embedding models without credentials", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withFetch(
    async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      await gate;
      if (
        url.endsWith("/models") &&
        !url.includes("/embeddings/") &&
        !url.includes("/images/") &&
        !url.includes("/videos/")
      ) {
        return catalog([
          {
            id: "openai/gpt-generation",
            created: 200,
            architecture: {
              modality: "text->text",
              input_modalities: ["text"],
              output_modalities: ["text"]
            },
            supported_parameters: ["tools", "tool_choice"]
          },
          { id: 42 },
          null
        ]);
      }
      if (url.includes("/embeddings/models")) {
        return catalog([{ id: "openai/text-embedding-ada-002", created: 100 }]);
      }
      return catalog([]);
    },
    async () => {
      const client = new OpenRouterModelMetadataClient();
      const first = runRouteKitEffect(client.models());
      const second = runRouteKitEffect(client.models());
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        calls.length,
        4,
        "all task catalogs start concurrently and one refresh is shared"
      );
      release();
      const [metadata] = await Promise.all([first, second]);
      assert.deepEqual(metadata.get("openai/gpt-generation")?.architecture?.outputModalities, [
        "text"
      ]);
      assert.deepEqual(metadata.get("openai/gpt-generation")?.supportedParameters, [
        "tools",
        "tool_choice"
      ]);
      assert.equal(metadata.get("openai/gpt-generation")?.createdAt, 200);
      assert.deepEqual(
        metadata.get("openai/text-embedding-ada-002")?.architecture?.outputModalities,
        ["embeddings"]
      );
      assert.equal(metadata.get("openai/text-embedding-ada-002")?.createdAt, 100);
      assert.ok(calls.every(({ init }) => acceptJson(init) && init?.credentials === undefined));
      await runRouteKitEffect(client.models());
      assert.equal(calls.length, 4, "fresh metadata is served from memory");
    }
  );
});

test("OpenRouter metadata serves stale cache after refresh failure and then expires it", async () => {
  let now = 0;
  let failing = false;
  await withFetch(
    async () => {
      if (failing) throw new Error("offline");
      return catalog([
        {
          id: "openai/gpt-generation",
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"]
          },
          supported_parameters: ["tools"]
        }
      ]);
    },
    async () => {
      const client = new OpenRouterModelMetadataClient({
        now: () => now,
        freshMs: 5,
        staleMs: 20
      });
      const initial = await runRouteKitEffect(client.models());
      failing = true;
      now = 10;
      assert.equal(await runRouteKitEffect(client.models()), initial);
      now = 30;
      await assert.rejects(() => runRouteKitEffect(client.models()), /offline/);
    }
  );
});

test("Codex enrichment fails closed for unknown OpenAI models and preserves explicit selection", async () => {
  let fetches = 0;
  await withFetch(
    async (input) => {
      fetches += 1;
      return String(input).includes("/embeddings/models")
        ? catalog([{ id: "openai/text-embedding-ada-002" }])
        : catalog([]);
    },
    async () => {
      const metadata = new OpenRouterModelMetadataClient();
      const models = [
        {
          id: "openai/text-embedding-ada-002",
          nativeId: "text-embedding-ada-002",
          provider: "openai",
          billingScope: "metered-api"
        }
      ] as const;
      await assert.rejects(
        () => runRouteKitEffect(resolveCodexStartupModel({ models }, { openRouter: metadata })),
        /no advertised model/
      );
      assert.equal(fetches, 4);
      assert.equal(
        (
          await runRouteKitEffect(
            resolveCodexStartupModel(
              { models, requestedModel: "openai/text-embedding-ada-002" },
              { openRouter: metadata }
            )
          )
        ).model,
        "openai/text-embedding-ada-002"
      );
      assert.equal(fetches, 4, "explicit selection never refreshes OpenRouter metadata");
    }
  );
});

test("Codex enrichment preserves native recency and fills missing OpenAI recency", async () => {
  let fetches = 0;
  await withFetch(
    async (input) => {
      fetches += 1;
      const url = String(input);
      if (
        url.endsWith("/models") &&
        !url.includes("/embeddings/") &&
        !url.includes("/images/") &&
        !url.includes("/videos/")
      ) {
        return catalog([
          {
            id: "openai/native-created",
            created: 900,
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text"]
            },
            supported_parameters: ["tools"]
          },
          {
            id: "openai/enriched-created",
            created: 800,
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text"]
            },
            supported_parameters: ["tools"]
          }
        ]);
      }
      return catalog([]);
    },
    async () => {
      const metadata = new OpenRouterModelMetadataClient();
      const selected = await runRouteKitEffect(
        resolveCodexStartupModel(
          {
            preferredModel: "openai/embedding",
            models: [
              {
                id: "openai/embedding",
                provider: "openai",
                billingScope: "metered-api",
                architecture: {
                  inputModalities: ["text"],
                  outputModalities: ["embeddings"]
                }
              },
              {
                id: "openai/native-created",
                nativeId: "native-created",
                provider: "openai",
                billingScope: "metered-api",
                createdAt: 700
              },
              {
                id: "openai/enriched-created",
                nativeId: "enriched-created",
                provider: "openai",
                billingScope: "metered-api"
              }
            ]
          },
          { openRouter: metadata }
        )
      );
      assert.equal(selected.model, "openai/enriched-created");
      assert.equal(
        selected.models.find((model) => model.id === "openai/native-created")?.createdAt,
        700,
        "provider-native creation time wins over OpenRouter"
      );
      assert.equal(
        selected.models.find((model) => model.id === "openai/enriched-created")?.createdAt,
        800
      );
      assert.equal(fetches, 4);
    }
  );
});

test("compatible preferred model returns without fetching fallback recency", async () => {
  let fetches = 0;
  await withFetch(
    async () => {
      fetches += 1;
      throw new Error("must not fetch");
    },
    async () => {
      const metadata = new OpenRouterModelMetadataClient();
      const compatible = {
        id: "openai/configured",
        provider: "openai",
        billingScope: "metered-api",
        architecture: {
          inputModalities: ["text"],
          outputModalities: ["text"]
        },
        supportedParameters: ["tools"]
      } as const;
      const selected = await runRouteKitEffect(
        resolveCodexStartupModel(
          {
            models: [compatible, { id: "openai/unknown", provider: "openai" }],
            preferredModel: compatible.id
          },
          { openRouter: metadata }
        )
      );
      assert.equal(selected.model, compatible.id);
      assert.equal(fetches, 0);
    }
  );
});

test("Codex enrichment reports an actionable RouteKit-owned metadata error", async () => {
  await withFetch(
    async () => {
      throw new Error("offline");
    },
    async () => {
      const unavailable = new OpenRouterModelMetadataClient();
      await assert.rejects(
        () =>
          runRouteKitEffect(
            resolveCodexStartupModel(
              {
                models: [{ id: "openai/unknown", provider: "openai" }]
              },
              { openRouter: unavailable }
            )
          ),
        (error: unknown) =>
          error instanceof Error &&
          error.message ===
            "routekit codex could not verify OpenAI model compatibility and recency because " +
              "OpenRouter model metadata is unavailable. Retry, or select a model explicitly with " +
              "`routekit codex <provider/model>`."
      );
    }
  );
});

const hangFetch: typeof fetch = async (_input, init) => {
  const signal = init?.signal;
  const aborted = (): Error =>
    signal?.reason instanceof Error ? signal.reason : new Error("aborted");
  if (signal?.aborted === true) return Promise.reject(aborted());
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(aborted()), { once: true });
  });
};

test("OpenRouter metadata propagates caller cancellation", async () => {
  await withFetch(hangFetch, async () => {
    const canceled = new OpenRouterModelMetadataClient({ timeoutMs: 25 });
    const controller = new AbortController();
    const pending = runRouteKitEffect(canceled.models(controller.signal));
    controller.abort(new Error("caller canceled"));
    await assert.rejects(pending, /caller canceled/);
  });
});

test("OpenRouter metadata enforces its timeout", async () => {
  await withFetch(hangFetch, async () => {
    const timedOut = new OpenRouterModelMetadataClient({ timeoutMs: 5 });
    await assert.rejects(
      () => runRouteKitEffect(timedOut.models()),
      (error: unknown) => error instanceof Error && error.name === "TimeoutError"
    );
  });
});
