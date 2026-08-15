import type { Effect } from "effect";

import { Context, Layer, Schema } from "effect";

import type { OpenRouterModel } from "../../../../contracts/author/src/openrouter-models.ts";

/**
 * The internal Effect port over the public OpenRouter catalog. The author SDK
 * still ships {@link fetchOpenRouterModels} (a plain, Effect-free function for
 * external feature authors and the React chat TUI); this service is the
 * runtime-side counterpart for Effect callers, giving the fetch a typed error
 * channel and a DI seam the raw `await fetch` lacked. The live HTTP adapter is
 * {@link OpenRouterModelsLive} (openrouter-models-live.ts), which talks over the
 * injected `HttpClient` and reuses the SDK's `decodeOpenRouterModels` so the
 * wire schema stays single-sourced. Consumers `yield* OpenRouterModels`; tests
 * inject a fake via {@link OpenRouterModels.layerTest}.
 */

class OpenRouterModelsError extends Schema.TaggedError<OpenRouterModelsError>()(
  "OpenRouterModelsError",
  {
    detail: Schema.String,
  }
) {
  override readonly message = this.detail;
}

interface OpenRouterModelsShape {
  /** Fetch and decode the OpenRouter catalog, projected to picker-ready models. */
  readonly fetchCatalog: Effect.Effect<
    readonly OpenRouterModel[],
    OpenRouterModelsError
  >;
}

export class OpenRouterModels extends Context.Service<
  OpenRouterModels,
  OpenRouterModelsShape
>()("ori/runtime/OpenRouterModels") {
  /**
   * Test seam: an inert default whose `fetchCatalog` fails with a deterministic
   * {@link OpenRouterModelsError}, so a test that unexpectedly hits the network
   * fails loudly. Pass `fetchCatalog` to stub a catalog.
   */
  static readonly layerTest = (
    impl?: Partial<OpenRouterModelsShape>
  ): Layer.Layer<OpenRouterModels> =>
    Layer.succeed(OpenRouterModels)(
      OpenRouterModels.of({
        fetchCatalog: new OpenRouterModelsError({
          detail: "OpenRouterModels.layerTest: no fetchCatalog configured",
        }),
        ...impl,
      })
    );
}

export type { OpenRouterModelsShape };
export { OpenRouterModelsError };
