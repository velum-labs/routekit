import type { Scope } from "effect";

import { Context, Effect, Layer } from "effect";

import type {
  AcpAgentConnectionShape,
  AcpClientRequestHandlerShape,
} from "../../acp-agent/src/service.ts";

import { AcpAgentConnectionLive } from "../../acp-agent/src/connection.ts";
import { AcpAgentConnection } from "../../acp-agent/src/service.ts";

import type { AcpTransportPair } from "./transport-pair.ts";

import {
  acpClientRequestHandlerLive,
  acpTransportLive,
} from "./selected-adapter-layers.ts";

/**
 * The adapter-side bridge a selected peer wires up. `cancelSession` and `handle`
 * cross the `AcpClientRequestHandler` tag; `bind` and `run` stay off the tag
 * because the connection does not exist yet when that layer is provided.
 */
export interface AcpPeerBridge extends Pick<
  AcpClientRequestHandlerShape,
  "cancelSession" | "handle"
> {
  readonly bind: (connection: AcpAgentConnectionShape) => Effect.Effect<void>;
  readonly run: Effect.Effect<void, never, Scope.Scope>;
}

// Peer exit can leave ACP shutdown or native kill waiting on an exitCode that
// never resolves. Bound terminate so scoped test/runtime teardown cannot hang.
const boundedTerminate = <A, E>(
  effect: Effect.Effect<A, E>
): Effect.Effect<void> =>
  effect.pipe(Effect.asVoid, Effect.timeout("2 seconds"), Effect.ignore);

/**
 * Builds the ACP agent connection over a transport pair, hands it back to the
 * bridge, and forks the two long-running pumps (the native event loop and the
 * native process's own stderr drain) into the caller's scope.
 *
 * `bind` must happen before `run` is forked: the event loop awaits the bound
 * connection on its first session update, and binding after the fork would race
 * that await. The event loop is `forkScoped`, so the peer's scope owns it and a
 * caller that never calls `terminate` cannot leak it. The stderr drain is
 * `forkDetach` instead, because a hard peer exit can leave its pipe open with no
 * EOF and scoped teardown would then hang; it stops when the drain itself
 * observes the process exit.
 */
export const startAcpPeer = Effect.fn(function* <ShutdownErr>(input: {
  readonly bridge: AcpPeerBridge;
  readonly drainStderr: Effect.Effect<void>;
  readonly nativeShutdown: Effect.Effect<void, ShutdownErr>;
  readonly pair: AcpTransportPair;
}) {
  const { bridge, drainStderr, nativeShutdown, pair } = input;
  const dependencies = Layer.merge(
    acpClientRequestHandlerLive(bridge),
    acpTransportLive(pair.agent)
  );
  const connectionContext = yield* Layer.build(
    AcpAgentConnectionLive().pipe(Layer.provide(dependencies))
  );
  const connection = Context.get(connectionContext, AcpAgentConnection);
  yield* bridge.bind(connection);
  yield* bridge.run.pipe(Effect.forkScoped);
  // Detached, not scoped: draining stderr after a hard peer exit can block on a
  // pipe that never EOFs, and scoped teardown would then hang the whole turn.
  yield* drainStderr.pipe(Effect.forkDetach);
  return {
    terminate: boundedTerminate(connection.shutdown).pipe(
      Effect.andThen(boundedTerminate(nativeShutdown)),
      Effect.andThen(boundedTerminate(pair.close))
    ),
    transport: pair.client,
  };
});
