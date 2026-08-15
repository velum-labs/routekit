import { Context, Effect, Layer, Option } from "effect";

import type {
  RuntimeEnvironmentError,
  RuntimeSecretError,
} from "../errors.ts";
import type {
  RuntimeSecretName,
  RuntimeSecretValue,
} from "./services.ts";

/**
 * The runtime-secret boundary: resolves a named secret to a redacted value.
 * This is a pure port — the effectful implementation lives in the
 * `@routekit-eval-engine/runtime-io` adapter (`runtime-environment.ts`) as
 * `RuntimeSecretStoreLive`, which resolves secrets by reading through
 * {@link RuntimeEnvironment}. {@link RuntimeSecretStore.layerTest} provides a
 * deterministic stand-in for tests.
 */
export interface RuntimeSecretStoreShape {
  /**
   * Resolves a named secret. The value is {@link RuntimeSecretValue | redacted},
   * so it never renders in logs or errors; unwrap it with `Redacted.value` only
   * at the point of use. An unconfigured secret resolves to `Option.none`.
   */
  readonly get: (
    name: RuntimeSecretName
  ) => Effect.Effect<
    Option.Option<RuntimeSecretValue>,
    RuntimeEnvironmentError | RuntimeSecretError
  >;
}

export class RuntimeSecretStore extends Context.Service<
  RuntimeSecretStore,
  RuntimeSecretStoreShape
>()("routekit-eval/runtime/RuntimeSecretStore") {
  /**
   * Test seam: a `RuntimeSecretStore` with an inert default that reports every
   * secret as absent (`Option.none`). Override `get` for a case that needs a
   * resolvable secret; the `@routekit-eval-engine/runtime-io` `runtimeSecretStoreFromRecord`
   * helper is the record-seeded alternative when a test wants the real
   * name-match and normalization path.
   */
  static readonly layerTest = (
    impl: Partial<RuntimeSecretStoreShape>
  ): Layer.Layer<RuntimeSecretStore> =>
    Layer.succeed(RuntimeSecretStore)(
      RuntimeSecretStore.of({
        get: () => Effect.succeed(Option.none<RuntimeSecretValue>()),
        ...impl,
      })
    );
}
