import { Effect, Layer } from "effect";
import { runCliEffect } from "./cli-session.js";
import { routekitClient } from "./client.js";
import { DaemonClient, type DaemonClientService } from "./services/daemon-client/service.js";

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

/** Effect-native daemon-client program for CLI command handlers. */
export function withCliClient<A, E, R>(
  run: (client: DaemonClientService) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | unknown, Exclude<R, DaemonClient>> {
  return DaemonClient.use(run).pipe(Effect.provide(CliLive)) as Effect.Effect<
    A,
    E | unknown,
    Exclude<R, DaemonClient>
  >;
}

/** One Commander-edge run that yields the daemon client then the command program. */
export function runCliClient<A, E, R>(
  run: (client: DaemonClientService) => Effect.Effect<A, E, R>
): Promise<A> {
  return runCliEffect(withCliClient(run));
}
