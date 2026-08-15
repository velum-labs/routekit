import type { Effect } from "effect";

import { Context, Layer, Schema } from "effect";

import type { GatewayModel } from "../../../../contracts/author/src/gateway-models.ts";

/**
 * The internal Effect port over the public Gateway catalog. The author SDK
 * still ships {@link fetchGatewayModels} (a plain, Effect-free function for
 * external feature authors and the React chat TUI); this service is the
 * runtime-side counterpart for Effect callers, giving the fetch a typed error
 * channel and a DI seam the raw `await fetch` lacked. The live HTTP adapter is
 * {@link GatewayModelsLive} (gateway-models-live.ts), which talks over the
 * injected `HttpClient` and reuses the SDK's `decodeGatewayModels` so the
 * wire schema stays single-sourced. Consumers `yield* GatewayModels`; tests
 * inject a fake via {@link GatewayModels.layerTest}.
 */

class GatewayModelsError extends Schema.TaggedErrorClass<GatewayModelsError>()(
  "GatewayModelsError",
  {
    detail: Schema.String,
  }
) {
  override readonly message = this.detail;
}

interface GatewayModelsShape {
  /** Fetch and decode the Gateway catalog, projected to picker-ready models. */
  readonly fetchCatalog: Effect.Effect<
    readonly GatewayModel[],
    GatewayModelsError
  >;
}

export class GatewayModels extends Context.Service<
  GatewayModels,
  GatewayModelsShape
>()("routekit-eval/runtime/GatewayModels") {
  /**
   * Test seam: an inert default whose `fetchCatalog` fails with a deterministic
   * {@link GatewayModelsError}, so a test that unexpectedly hits the network
   * fails loudly. Pass `fetchCatalog` to stub a catalog.
   */
  static readonly layerTest = (
    impl?: Partial<GatewayModelsShape>
  ): Layer.Layer<GatewayModels> =>
    Layer.succeed(GatewayModels)(
      GatewayModels.of({
        fetchCatalog: new GatewayModelsError({
          detail: "GatewayModels.layerTest: no fetchCatalog configured",
        }),
        ...impl,
      })
    );
}

export type { GatewayModelsShape };
export { GatewayModelsError };
