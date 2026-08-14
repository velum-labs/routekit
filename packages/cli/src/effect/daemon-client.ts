import { RouteKitControlClient } from "@velum-labs/routekit-control";
import { Context, Effect, Layer } from "effect";

/** Process-lifetime control client for one CLI command program.
 *
 * @effect-expect-leaking HttpClient
 */
export class DaemonClient extends Context.Service<DaemonClient, RouteKitControlClient>()(
  "@velum-labs/routekit/DaemonClient"
) {
  /**
   * Lazy so this module can load before `routekitClient` finishes initializing
   * (`client.ts` imports `cli-session.ts`, which imports this file).
   */
  static readonly layer = Layer.unwrap(
    Effect.promise(() => import("../client.js")).pipe(
      Effect.map((mod) => Layer.effect(DaemonClient, mod.routekitClient))
    )
  );
}
