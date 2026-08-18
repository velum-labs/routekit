import { Effect, Layer } from "effect";
import { evalModelsCatalogUrl } from "../../../../../../host-env.ts";
import { HttpClient } from "effect/unstable/http";

import {
  decodeOpenRouterModels,
} from "../../../../contracts/author/src/openrouter-models.ts";
import { isOkStatus } from "../../../../contracts/internal/src/http-client.ts";
import {
  OpenRouterModels,
  OpenRouterModelsError,
} from "./models-service.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const fetchCatalog = Effect.fn("OpenRouterModels.fetchCatalog")(function* (
  client: HttpClient.HttpClient
) {
  const response = yield* client.get(evalModelsCatalogUrl()).pipe(
    Effect.mapError(
      (cause) =>
        new OpenRouterModelsError({
          detail: `could not reach the OpenRouter catalog at ${evalModelsCatalogUrl()}: ${formatUnknownError(cause)}`,
        })
    )
  );
  // `HttpClientResponse` does not surface `statusText`, so the non-ok message
  // carries the numeric status only.
  if (!isOkStatus(response.status)) {
    return yield* new OpenRouterModelsError({
      detail: `OpenRouter models request failed with HTTP ${response.status}`,
    });
  }
  const payload = yield* response.json.pipe(
    Effect.mapError(
      (cause) =>
        new OpenRouterModelsError({
          detail: `could not read the OpenRouter catalog body: ${formatUnknownError(cause)}`,
        })
    )
  );
  // Reuse the SDK's decode/projection so the wire schema stays single-sourced;
  // it throws on an unexpected shape, mapped here into the typed channel.
  return yield* Effect.try({
    catch: (cause) =>
      new OpenRouterModelsError({
        detail: `OpenRouter catalog had an unexpected shape: ${formatUnknownError(cause)}`,
      }),
    try: () => decodeOpenRouterModels(payload),
  });
});

/**
 * Live {@link OpenRouterModels}: the public OpenRouter catalog over the injected
 * `HttpClient`. The transport is captured once at layer build and rides this
 * layer's build-time requirement channel, so `fetchCatalog` stays requirement-
 * free (matching {@link ManagedSkillFetcherLive}). Each provide site wires a
 * nested `Layer.provide(fetchHttpClientLayer)` to discharge it.
 */
export const OpenRouterModelsLive: Layer.Layer<
  OpenRouterModels,
  never,
  HttpClient.HttpClient
> = Layer.effect(OpenRouterModels)(
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return OpenRouterModels.of({
      fetchCatalog: fetchCatalog(client),
    });
  })
);
