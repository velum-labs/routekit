import { Effect, Layer, Schema } from "effect";

import type { TelemetryUsageSinkShape } from "../../../contracts/internal/src/runtime/telemetry-usage-sink.ts";
import type { TelemetryShape } from "./telemetry.ts";
import type { TelemetryEventName } from "./telemetry-event.ts";

import { TelemetryUsageSink } from "../../../contracts/internal/src/runtime/telemetry-usage-sink.ts";
import { Telemetry } from "./telemetry.ts";
import { TelemetryEventNameSchema } from "./telemetry-event.ts";

const isTelemetryEvent = (value: string): value is TelemetryEventName =>
  Schema.is(TelemetryEventNameSchema)(value);

export const makeTelemetryUsageSink = (
  telemetry: TelemetryShape
): TelemetryUsageSinkShape => ({
  write: (
    event: string,
    props: Readonly<Record<string, string | number | boolean>>
  ): Effect.Effect<void> =>
    isTelemetryEvent(event)
      ? telemetry.emit(event, props).pipe(Effect.ignore)
      : Effect.void,
});

export const telemetryUsageSinkLayer = Layer.effect(TelemetryUsageSink)(
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    return TelemetryUsageSink.of(makeTelemetryUsageSink(telemetry));
  })
);
