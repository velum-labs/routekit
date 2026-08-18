import { Context, Effect, Layer } from "effect";

export type TelemetryUsageValue = string | number | boolean;

export interface TelemetryUsageSinkShape {
  readonly write: (
    event: string,
    props: Readonly<Record<string, TelemetryUsageValue>>
  ) => Effect.Effect<void>;
}

export class TelemetryUsageSink extends Context.Service<
  TelemetryUsageSink,
  TelemetryUsageSinkShape
>()("ori/runtime/TelemetryUsageSink") {
  static readonly layerTest = (
    impl: Partial<TelemetryUsageSinkShape> = {}
  ): Layer.Layer<TelemetryUsageSink> =>
    Layer.succeed(TelemetryUsageSink)(
      TelemetryUsageSink.of({
        write: () => Effect.void,
        ...impl,
      })
    );
}
