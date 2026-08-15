import type { Crypto, FileSystem, Path } from "effect";
import type { HttpClient } from "effect/unstable/http";

import { Effect, Layer, Schema } from "effect";

import type { CliIo } from "../../../contracts/internal/src/cli/cli-io.ts";
import type { HostProcess } from "../../../contracts/internal/src/cli/host-process.ts";
import type { TelemetryLiveLayer } from "./telemetry-live.ts";

import { TelemetryObserver } from "../../../contracts/internal/src/runtime/telemetry-observer.ts";
import { Telemetry } from "./telemetry.ts";
import { TelemetryEventNameSchema } from "./telemetry-event.ts";
import {
  TelemetryDaemonLive,
  TelemetryLive,
} from "./telemetry-live.ts";

// Keep the runtime guard for callers crossing a JavaScript boundary or
// bypassing the TypeScript contract; unknown names are dropped before they can
// poison a batch.
const isKnownTelemetryEvent = Schema.is(TelemetryEventNameSchema);
type TelemetryLiveRequirements =
  | CliIo
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HostProcess
  | HttpClient.HttpClient
  | Path.Path;

const makeTelemetryObserver = Effect.gen(function* () {
  const telemetry = yield* Telemetry;
  return TelemetryObserver.of({
    observe: (event, props) =>
      isKnownTelemetryEvent(event)
        ? telemetry.emit(event, props).pipe(Effect.ignore)
        : Effect.void,
  });
});

const makeTelemetryObserverLayer = (
  telemetryLayer: TelemetryLiveLayer
): Layer.Layer<
  Telemetry | TelemetryObserver,
  never,
  TelemetryLiveRequirements
> =>
  Layer.effect(TelemetryObserver, makeTelemetryObserver).pipe(
    Layer.provideMerge(telemetryLayer)
  );

// `provideMerge` exposes the shared live Telemetry service to callers, so a
// single buffering client backs both the CLI's direct `Telemetry.emit` and
// the observer's forwarded events (one session identity for the whole run).
export const telemetryObserverLayer = makeTelemetryObserverLayer(TelemetryLive);

// Daemons own a separate telemetry session and must not emit CLI first-use
// side effects when their long-lived runtime is built.
export const daemonTelemetryObserverLayer = Layer.effect(
  TelemetryObserver,
  makeTelemetryObserver
).pipe(Layer.provide(TelemetryDaemonLive));
