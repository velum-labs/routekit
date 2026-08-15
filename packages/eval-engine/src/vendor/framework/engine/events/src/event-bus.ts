import { Context, Effect, Layer, PubSub, Stream } from "effect";

import type { AgentRuntimeEvent } from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";

import { RuntimeValidationError } from "../../../contracts/internal/src/errors.ts";
import { decodeAgentRuntimeEvent } from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";

export interface AgentEventBusShape {
  readonly publish: (
    event: AgentRuntimeEvent
  ) => Effect.Effect<void, RuntimeValidationError>;
  readonly stream: Stream.Stream<AgentRuntimeEvent>;
}

export class AgentEventBus extends Context.Service<
  AgentEventBus,
  AgentEventBusShape
>()("ori/runtime/AgentEventBus") {
  static readonly layer = Layer.effect(AgentEventBus)(
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<AgentRuntimeEvent>();

      const publish = Effect.fn("AgentEventBus.publish")(
        (event: AgentRuntimeEvent) =>
          decodeAgentRuntimeEvent(event).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimeValidationError({
                  cause,
                  detail: "Invalid agent runtime event",
                })
            ),
            Effect.andThen((decoded) => PubSub.publish(pubsub, decoded)),
            Effect.asVoid
          )
      );

      return AgentEventBus.of({
        publish,
        stream: Stream.fromPubSub(pubsub),
      });
    })
  );
}
