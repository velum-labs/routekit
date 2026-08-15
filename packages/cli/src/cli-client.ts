import { Effect, Layer } from "effect";
import { runCliEffect } from "./cli-session.js";
import { routekitClient } from "./client.js";
import { DaemonClient, type DaemonClientService } from "./effect/daemon-client.js";

/** CLI process layer: one daemon client per Commander program. */
export const CliLive = Layer.effect(
  DaemonClient,
  routekitClient.pipe(
    Effect.map((client) =>
      DaemonClient.of({
        health: client.health(),
        hello: client.hello(),
        call: client.call.bind(client)
      })
    )
  )
);

/** One Commander-edge run that yields the daemon client then the command program. */
export function runCliClient<A, E, R>(
  run: (client: DaemonClientService) => Effect.Effect<A, E, R>
): Promise<A> {
  return runCliEffect(DaemonClient.use(run).pipe(Effect.provide(CliLive)));
}
