import { Layer, ManagedRuntime } from "effect";

import type { makeRouteKitEvalDaemonLayer } from "./index.ts";

import { logToStderrLayer } from "../../../../../contracts/internal/src/cli/output-mode.ts";

type RouteKitEvalDaemonService = Layer.Success<ReturnType<typeof makeRouteKitEvalDaemonLayer>>;
type FullyProvidedLayer = Layer.Layer<never, Error>;

export interface RouteKitEvalDaemonRuntimeOptions<
  Dependencies extends FullyProvidedLayer,
> {
  readonly dependencies: Dependencies;
  readonly daemonLayer: Layer.Layer<
    RouteKitEvalDaemonService,
    Layer.Error<Dependencies>
  >;
}

export const makeRouteKitEvalDaemonRuntime = <Dependencies extends FullyProvidedLayer>(
  options: RouteKitEvalDaemonRuntimeOptions<Dependencies>
): ManagedRuntime.ManagedRuntime<
  Layer.Success<Dependencies> | RouteKitEvalDaemonService,
  Layer.Error<Dependencies>
> => {
  const { dependencies } = options;
  return ManagedRuntime.make(
    Layer.mergeAll(dependencies, options.daemonLayer).pipe(
      Layer.provideMerge(logToStderrLayer())
    )
  );
};
