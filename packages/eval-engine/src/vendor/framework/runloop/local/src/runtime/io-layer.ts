import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { CliIoLive } from "../../../../engine/runtime-io/src/cli-io.ts";
import { HostProcessLive } from "../../../../engine/runtime-io/src/host-process.ts";
import { CliLogSinkLive, Logger } from "../../../../engine/runtime-io/src/logger.ts";
import {
  RuntimeEnvironmentLive,
  RuntimeSecretStoreLive,
} from "../../../../engine/runtime-io/src/runtime-environment.ts";

// The live env reads through HostProcess and the live secret store reads
// through the env, so the chain is provideMerge'd to wire the requirements while
// keeping all three services exposed on `hostRuntimeLayer`.
const runtimeEnvironmentLayer = RuntimeEnvironmentLive.pipe(
  Layer.provideMerge(HostProcessLive)
);
const runtimeSecretStoreLayer = RuntimeSecretStoreLive.pipe(
  Layer.provideMerge(runtimeEnvironmentLayer)
);

export { nodeServicesLayer };

export const cliIoLayer = CliIoLive.pipe(Layer.provide(nodeServicesLayer));

// `CliLogSinkLive` keeps `CliIo` in its requirement channel (it does not
// self-provide it), so `provideMerge` feeds `cliIoLayer`'s `CliIo` into the sink
// and re-exposes it; `Logger` then consumes the resulting `LogSink`. Records are
// written to stderr via `CliIo` so they never collide with `stdout` results
// (RFC 0011). The daemon swaps in a log-hub sink instead (see daemon-layers.ts).
const cliLogSinkLayer = CliLogSinkLive.pipe(Layer.provideMerge(cliIoLayer));
export const loggerLayer = Logger.layer.pipe(Layer.provide(cliLogSinkLayer));

// `runtimeSecretStoreLayer` already exposes HostProcess and RuntimeEnvironment
// (via provideMerge), so the composite is just that chain.
export const hostRuntimeLayer = runtimeSecretStoreLayer;
