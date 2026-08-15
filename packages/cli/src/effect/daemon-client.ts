import { RouteKitControlClient } from "@velum-labs/routekit-control";
import { Context } from "effect";

/** Process-lifetime control client for one CLI command program.
 *
 * @effect-expect-leaking HttpClient
 */
export class DaemonClient extends Context.Service<DaemonClient, RouteKitControlClient>()(
  "@velum-labs/routekit/DaemonClient"
) {}
