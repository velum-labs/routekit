import { RouteKitControlClient } from "@velum-labs/routekit-control";
import { Context } from "effect";

export type DaemonClientService = Omit<RouteKitControlClient, "health" | "hello"> & {
  readonly health: ReturnType<RouteKitControlClient["health"]>;
  readonly hello: ReturnType<RouteKitControlClient["hello"]>;
};

/** Process-lifetime control client for one CLI command program.
 *
 * @effect-expect-leaking HttpClient
 */
export class DaemonClient extends Context.Service<DaemonClient, DaemonClientService>()(
  "@velum-labs/routekit/DaemonClient"
) {}
