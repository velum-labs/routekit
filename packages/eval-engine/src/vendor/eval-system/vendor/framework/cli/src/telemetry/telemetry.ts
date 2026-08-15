import { Context, Effect, Layer } from "effect";

import type {
  TelemetryEventName,
  TelemetryProps,
} from "./telemetry-event.ts";

interface TelemetryShape {
  readonly emit: (
    event: TelemetryEventName,
    props?: TelemetryProps
  ) => Effect.Effect<void>;
  readonly flush: Effect.Effect<void>;
}

/**
 * RFC 0012 usage telemetry port. This module owns only the {@link Telemetry}
 * tag and its {@link TelemetryShape} contract; the live client that buffers
 * anonymous product-usage events and flushes them to the Gateway ingest
 * endpoint is the `TelemetryLive` adapter in `telemetry-live.ts`.
 */
export class Telemetry extends Context.Service<Telemetry, TelemetryShape>()(
  "routekit-eval/cli/Telemetry"
) {
  /**
   * Test seam: an inert `Telemetry` whose `emit` and `flush` are no-ops — the
   * same strict no-op the live adapter falls back to when telemetry is disabled
   * (`ROUTEKIT_EVAL_TELEMETRY=0`) or its setup fails. Override only the fields a case
   * cares about; unset fields keep the no-op default. The effectful buffering
   * client lives in the `TelemetryLive` adapter (`telemetry-live.ts`).
   */
  static readonly layerTest = (
    impl: Partial<TelemetryShape>
  ): Layer.Layer<Telemetry> =>
    Layer.succeed(Telemetry)(
      Telemetry.of({
        emit: () => Effect.void,
        flush: Effect.void,
        ...impl,
      })
    );
}

export type { TelemetryShape };
