import type { ServiceRecord } from "@velum-labs/routekit-runtime/service";
import { Context, Effect } from "effect";
import type { DaemonRuntimeState } from "../../daemon-runtime-state.js";

export type DaemonRuntimeValue = {
  readonly record: ServiceRecord;
  readonly dataUrl: string;
  readonly controlUrl: string;
  readonly prepareClose: Effect.Effect<void, Error>;
  readonly prepareRetire: (graceMs?: number) => Effect.Effect<void, Error>;
  readonly pauseMutations: Effect.Effect<ReturnType<DaemonRuntimeState["snapshot"]>, Error>;
  readonly resumeMutations: Effect.Effect<void, never>;
  readonly snapshot: Effect.Effect<ReturnType<DaemonRuntimeState["snapshot"]>, never>;
  readonly reload: Effect.Effect<void, Error>;
};

/** Running daemon resources acquired and released by the daemon live Layer. */
export class DaemonRuntime extends Context.Service<DaemonRuntime, DaemonRuntimeValue>()(
  "@velum-labs/routekit-daemon/DaemonRuntime"
) {}
