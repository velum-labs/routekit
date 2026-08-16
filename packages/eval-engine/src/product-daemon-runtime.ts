import {
  type EvalDaemonDependenciesOptions,
  makeEvalDaemonDependenciesLayer,
  makeProvidedEvalDaemonLayer
} from "./product-runtime.ts";
import { makeOriDaemonRuntime } from "./vendor/framework/runloop/local/src/daemon/core/layers.ts";
import type { DaemonRuntime } from "./vendor/framework/runloop/local/src/daemon/server/server-types.ts";

const makeProductDaemonRuntime = (options: EvalDaemonDependenciesOptions = {}): DaemonRuntime => {
  const dependencies = makeEvalDaemonDependenciesLayer(options);
  return makeOriDaemonRuntime<typeof dependencies>({
    daemonLayer: makeProvidedEvalDaemonLayer(dependencies, options),
    dependencies
  });
};

export { makeProductDaemonRuntime };
