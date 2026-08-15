import type { Crypto, FileSystem, Layer, Path } from "effect";
import type { HttpClient } from "effect/unstable/http";

import type { CliIo } from "../../../contracts/internal/src/cli/cli-io.ts";
import type { HostProcess } from "../../../contracts/internal/src/cli/host-process.ts";
import type { Telemetry } from "./telemetry.ts";

export interface TelemetryLayerOptions {
  readonly emitFirstUse: boolean;
}

export type TelemetryLiveLayer = Layer.Layer<
  Telemetry,
  never,
  | CliIo
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HostProcess
  | HttpClient.HttpClient
  | Path.Path
>;
