import { Context, Effect, Layer, Option } from "effect";

import type { RuntimeEnvironmentError } from "../errors.ts";

/**
 * The runtime-environment boundary: a single normalized environment-variable
 * read. This is a pure port — the effectful implementation that reads the real
 * process environment (through {@link HostProcess}) lives in the
 * `@routekit-eval-engine/runtime-io` adapter (`runtime-environment.ts`) as
 * `RuntimeEnvironmentLive`, and {@link RuntimeEnvironment.layerTest} provides a
 * deterministic stand-in for tests.
 */
export interface RuntimeEnvironmentShape {
  /**
   * Reads one environment variable, normalized: the value is trimmed, and a
   * missing or blank value resolves to `Option.none`. A read that throws is
   * surfaced as a {@link RuntimeEnvironmentError} on the failure channel.
   */
  readonly get: (
    name: string
  ) => Effect.Effect<Option.Option<string>, RuntimeEnvironmentError>;
}

export class RuntimeEnvironment extends Context.Service<
  RuntimeEnvironment,
  RuntimeEnvironmentShape
>()("routekit-eval/runtime/RuntimeEnvironment") {
  /**
   * Test seam: a `RuntimeEnvironment` with an inert default that reports every
   * name as absent (`Option.none`). Override `get` for a case that needs to
   * observe specific values; pass a closure over a fixture record to model a
   * populated environment.
   */
  static readonly layerTest = (
    impl: Partial<RuntimeEnvironmentShape>
  ): Layer.Layer<RuntimeEnvironment> =>
    Layer.succeed(RuntimeEnvironment)(
      RuntimeEnvironment.of({
        get: () => Effect.succeed(Option.none<string>()),
        ...impl,
      })
    );
}
