import { Layer, ManagedRuntime } from "effect";

import type { makeOriDaemonLayer } from "./index.ts";

import { logToStderrLayer } from "../../../../../contracts/internal/src/cli/output-mode.ts";

type OriDaemonService = Layer.Success<ReturnType<typeof makeOriDaemonLayer>>;
type FullyProvidedLayer = Layer.Layer<never, Error>;

export interface OriDaemonRuntimeOptions<
  Dependencies extends FullyProvidedLayer,
> {
  readonly dependencies: Dependencies;
  readonly daemonLayer: Layer.Layer<
    OriDaemonService,
    Layer.Error<Dependencies>
  >;
}

export const makeOriDaemonRuntime = <Dependencies extends FullyProvidedLayer>(
  options: OriDaemonRuntimeOptions<Dependencies>
): ManagedRuntime.ManagedRuntime<
  Layer.Success<Dependencies> | OriDaemonService,
  Layer.Error<Dependencies>
> => {
  const { dependencies } = options;
  return ManagedRuntime.make(
    Layer.mergeAll(dependencies, options.daemonLayer).pipe(
      Layer.provideMerge(logToStderrLayer())
    )
  );
};
