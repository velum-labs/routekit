import type { RouteKitControlClient } from "@velum-labs/routekit-control";
import { Effect, Layer } from "effect";
import { runCliEffect } from "./cli-session.js";
import { routekitClient } from "./client.js";
import { DaemonClient } from "./effect/daemon-client.js";

/** CLI process layer: one daemon client per Commander program. */
export const CliLive = Layer.effect(DaemonClient, routekitClient);

/** One Commander-edge run that yields the daemon client then the command program. */
export function runCliClient<A, E, R>(
  run: (client: RouteKitControlClient) => Effect.Effect<A, E, R>
): Promise<A> {
  return runCliEffect(DaemonClient.use(run).pipe(Effect.provide(CliLive)));
}
