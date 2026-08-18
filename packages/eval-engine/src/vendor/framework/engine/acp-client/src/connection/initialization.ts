import { Effect, Ref, Schema } from "effect";

import type {
  Enqueue,
  InitializationState,
  Terminate,
} from "./internal.ts";
import type { AcpRawRequest } from "./request-state.ts";
import type { AcpConnectionError } from "../errors.ts";
import type {
  AcpClientNotificationMethod,
  AcpClientNotificationParams,
  AcpCapabilitySnapshot,
  AcpClientRequestParams,
  AcpClientRequestResult,
  AcpConnectionShape,
  AcpInitializeParams,
  AcpOperationalRequestMethod,
} from "../service.ts";

import { makeNotify, protocolError } from "./protocol.ts";
import { CLIENT_REQUEST_SCHEMAS } from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import {
  AcpConnectionClosedError,
  AcpInitializationError,
  AcpProtocolVersionError,
} from "../errors.ts";

const beginInitialization = (
  state: Ref.Ref<InitializationState>
): Effect.Effect<void, AcpConnectionError> =>
  Ref.modify<InitializationState, Effect.Effect<void, AcpConnectionError>>(
    state,
    (current) => {
      switch (current.type) {
        case "fresh": {
          return [Effect.void, { type: "running" }] as const;
        }
        case "closed": {
          return [Effect.fail(current.error), current] as const;
        }
        case "running": {
          return [
            new AcpInitializationError({
              reason: "InitializationInProgress",
            }),
            current,
          ] as const;
        }
        case "ready": {
          return [
            new AcpInitializationError({ reason: "AlreadyInitialized" }),
            current,
          ] as const;
        }
        default: {
          return current satisfies never;
        }
      }
    }
  ).pipe(Effect.flatten);

export const requireCapabilities = (
  state: Ref.Ref<InitializationState>
): Effect.Effect<AcpCapabilitySnapshot, AcpConnectionError> =>
  Ref.get(state).pipe(
    Effect.flatMap((current) => {
      switch (current.type) {
        case "ready": {
          return Effect.succeed(current.snapshot);
        }
        case "closed": {
          return Effect.fail(current.error);
        }
        case "fresh":
        case "running": {
          return new AcpInitializationError({ reason: "NotInitialized" });
        }
        default: {
          return current satisfies never;
        }
      }
    })
  );

const deepFreeze = <A>(value: A): A => {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key));
  }
  return Object.freeze(value);
};

const completeInitialization = (
  state: Ref.Ref<InitializationState>,
  snapshot: AcpCapabilitySnapshot
): Effect.Effect<AcpCapabilitySnapshot, AcpConnectionError> =>
  Ref.modify<
    InitializationState,
    Effect.Effect<AcpCapabilitySnapshot, AcpConnectionError>
  >(state, (current) => {
    switch (current.type) {
      case "running": {
        return [
          Effect.succeed(snapshot),
          {
            snapshot,
            type: "ready",
          },
        ] as const;
      }
      case "closed": {
        return [Effect.fail(current.error), current] as const;
      }
      case "ready": {
        return [
          new AcpInitializationError({ reason: "AlreadyInitialized" }),
          current,
        ] as const;
      }
      case "fresh": {
        return [
          new AcpInitializationError({ reason: "NotInitialized" }),
          current,
        ] as const;
      }
      default: {
        return current satisfies never;
      }
    }
  }).pipe(Effect.flatten);

export const makeInitialize = ({
  request,
  state,
  terminate,
}: {
  readonly request: AcpRawRequest;
  readonly state: Ref.Ref<InitializationState>;
  readonly terminate: Terminate;
}): AcpConnectionShape["initialize"] =>
  Effect.fn("AcpConnection.initialize")(function* (
    params: AcpInitializeParams
  ) {
    const wireParams = {
      ...params,
      protocolVersion: 1,
    } as const;
    const decoded = yield* Schema.decodeUnknownEffect(
      CLIENT_REQUEST_SCHEMAS.initialize
    )(wireParams).pipe(Effect.mapError(protocolError));
    yield* beginInitialization(state);
    const result = yield* request("initialize", wireParams).pipe(
      Effect.tapError(terminate),
      Effect.onInterrupt(() =>
        terminate(
          new AcpConnectionClosedError({
            reason: "initialization interrupted",
          })
        )
      )
    );
    if (result.protocolVersion !== 1) {
      const error = new AcpProtocolVersionError({
        expected: 1,
        received: result.protocolVersion,
      });
      yield* terminate(error);
      return yield* error;
    }
    const snapshot: AcpCapabilitySnapshot = deepFreeze({
      agent: result.agentCapabilities,
      agentInfo: result.agentInfo,
      authMethods: result.authMethods,
      client: decoded.clientCapabilities,
    });
    return yield* completeInitialization(state, snapshot);
  });

export const makeOperationalNotify = (
  state: Ref.Ref<InitializationState>,
  enqueue: Enqueue
): AcpConnectionShape["notify"] => {
  const notify = makeNotify(enqueue);
  return <M extends AcpClientNotificationMethod>(
    method: M,
    params: AcpClientNotificationParams<M>
  ): Effect.Effect<void, AcpConnectionError> =>
    requireCapabilities(state).pipe(Effect.andThen(notify(method, params)));
};

export const makeOperationalRequest =
  (
    state: Ref.Ref<InitializationState>,
    request: AcpRawRequest
  ): AcpConnectionShape["request"] =>
  <M extends AcpOperationalRequestMethod>(
    method: M,
    params: AcpClientRequestParams<M>
  ): Effect.Effect<AcpClientRequestResult<M>, AcpConnectionError> =>
    requireCapabilities(state).pipe(Effect.andThen(request(method, params)));
