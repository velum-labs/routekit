import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import type { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import type { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";

import { CliIoLive } from "../../../../engine/runtime-io/src/cli-io.ts";
import { HostProcessLive } from "../../../../engine/runtime-io/src/host-process.ts";
import { CliLogSinkLive, Logger } from "../../../../engine/runtime-io/src/logger.ts";
import {
  RuntimeEnvironmentLive,
  RuntimeSecretStoreLive,
} from "../../../../engine/runtime-io/src/runtime-environment.ts";

export { nodeServicesLayer };

interface RuntimeIoLayerOptions {
  readonly cliIo?: Layer.Layer<CliIo>;
  readonly hostProcess?: Layer.Layer<HostProcess>;
}

/**
 * Compose production runtime IO around explicit process and CLI ports.
 * Calling with no options preserves the live CLI wiring.
 */
const makeRuntimeIoLayers = (options: RuntimeIoLayerOptions = {}) => {
  const hostProcessLayer = options.hostProcess ?? HostProcessLive;
  const cliIoLayer =
    options.cliIo ?? CliIoLive.pipe(Layer.provide(nodeServicesLayer));
  const runtimeEnvironmentLayer = RuntimeEnvironmentLive.pipe(
    Layer.provideMerge(hostProcessLayer)
  );
  const runtimeSecretStoreLayer = RuntimeSecretStoreLive.pipe(
    Layer.provideMerge(runtimeEnvironmentLayer)
  );
  // The secret-store chain keeps HostProcess and RuntimeEnvironment exposed.
  const hostRuntimeLayer = runtimeSecretStoreLayer;
  const cliLogSinkLayer = CliLogSinkLive.pipe(Layer.provideMerge(cliIoLayer));
  const loggerLayer = Logger.layer.pipe(Layer.provide(cliLogSinkLayer));
  const nodeRuntimeServicesLayer = Layer.mergeAll(
    nodeServicesLayer,
    cliIoLayer,
    hostRuntimeLayer
  );
  return {
    cliIoLayer,
    hostRuntimeLayer,
    loggerLayer,
    nodeRuntimeServicesLayer,
  } as const;
};

const liveRuntimeIoLayers = makeRuntimeIoLayers();

export const cliIoLayer = liveRuntimeIoLayers.cliIoLayer;
export const hostRuntimeLayer = liveRuntimeIoLayers.hostRuntimeLayer;
export const loggerLayer = liveRuntimeIoLayers.loggerLayer;
export { makeRuntimeIoLayers };
export type { RuntimeIoLayerOptions };
