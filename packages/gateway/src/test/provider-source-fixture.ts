import { type RouteKitPlatform, toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import type { BackendRequest, BackendRequestOptions } from "../providers/backend.js";
import type { DiscoveredModel, ProviderId, ProviderSource } from "../index.js";
import { openaiReasoningCapabilities } from "../providers/openai-reasoning.js";

type TestProviderSourceOptions = {
  readonly sourceId: ProviderId;
  readonly discoverModels: (
    signal?: AbortSignal
  ) => Effect.Effect<readonly DiscoveredModel[], Error, RouteKitPlatform>;
  readonly chat?: (
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ) => BackendRequest;
  readonly embeddings?: (
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ) => BackendRequest;
  readonly responses?: Readonly<{
    supports(model: string): boolean;
    execute(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest;
  }>;
  readonly capabilities?: ProviderSource["capabilities"];
  readonly close?: () => Promise<void> | void;
};

export function testProviderSource(options: TestProviderSourceOptions): ProviderSource {
  return {
    sourceId: options.sourceId,
    discovery: { discoverModels: options.discoverModels },
    requests: {
      chat: options.chat ?? (() => Effect.succeed(Response.json({}))),
      embeddings: options.embeddings ?? (() => Effect.succeed(Response.json({})))
    },
    responses:
      options.responses === undefined
        ? { kind: "unsupported" }
        : {
            kind: "responses",
            supports: options.responses.supports,
            execute: options.responses.execute
          },
    capabilities: options.capabilities ?? {
      forModel: () => ({}),
      reasoningForModel:
        options.sourceId === "openai"
          ? (model) => openaiReasoningCapabilities(model)
          : () => undefined
    },
    resource:
      options.close === undefined
        ? { kind: "borrowed" }
        : {
            kind: "owned",
            close: Effect.tryPromise({
              try: async () => await options.close!(),
              catch: toRouteKitFailure
            })
          }
  };
}
