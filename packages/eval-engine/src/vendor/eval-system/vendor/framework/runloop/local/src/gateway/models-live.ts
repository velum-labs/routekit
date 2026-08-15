import { Effect, Layer } from "effect";
import { evalModelsCatalogUrl } from "../../../../../../host-env.ts";
import { HttpClient } from "effect/unstable/http";

import {
  decodeGatewayModels,
} from "../../../../contracts/author/src/gateway-models.ts";
import { isOkStatus } from "../../../../contracts/internal/src/http-client.ts";
import {
  GatewayModels,
  GatewayModelsError,
} from "./models-service.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const fetchCatalog = Effect.fn("GatewayModels.fetchCatalog")(function* (
  client: HttpClient.HttpClient
) {
  const response = yield* client.get(evalModelsCatalogUrl()).pipe(
    Effect.mapError(
      (cause) =>
        new GatewayModelsError({
          detail: `could not reach the Gateway catalog at ${evalModelsCatalogUrl()}: ${formatUnknownError(cause)}`,
        })
    )
  );
  // `HttpClientResponse` does not surface `statusText`, so the non-ok message
  // carries the numeric status only.
  if (!isOkStatus(response.status)) {
    return yield* new GatewayModelsError({
      detail: `Gateway models request failed with HTTP ${response.status}`,
    });
  }
  const payload = yield* response.json.pipe(
    Effect.mapError(
      (cause) =>
        new GatewayModelsError({
          detail: `could not read the Gateway catalog body: ${formatUnknownError(cause)}`,
        })
    )
  );
  // Reuse the SDK's decode/projection so the wire schema stays single-sourced;
  // it throws on an unexpected shape, mapped here into the typed channel.
  return yield* Effect.try({
    catch: (cause) =>
      new GatewayModelsError({
        detail: `Gateway catalog had an unexpected shape: ${formatUnknownError(cause)}`,
      }),
    try: () => decodeGatewayModels(payload),
  });
});

/**
 * Live {@link GatewayModels}: the public Gateway catalog over the injected
 * `HttpClient`. The transport is captured once at layer build and rides this
 * layer's build-time requirement channel, so `fetchCatalog` stays requirement-
 * free (matching {@link ManagedSkillFetcherLive}). Each provide site wires a
 * nested `Layer.provide(fetchHttpClientLayer)` to discharge it.
 */
export const GatewayModelsLive: Layer.Layer<
  GatewayModels,
  never,
  HttpClient.HttpClient
> = Layer.effect(GatewayModels)(
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return GatewayModels.of({
      fetchCatalog: fetchCatalog(client),
    });
  })
);
