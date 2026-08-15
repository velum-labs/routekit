import type { PlatformError, Scope } from "effect";
// `effect/unstable/process` is the only Effect-native child-process API; it is
// still unstable but there is no stable alternative for spawning Pi.
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  Deferred,
  Effect,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";

import type { PiAdapterConfig } from "../config.ts";
import type { PiCredentialError } from "../errors.ts";
import type { RuntimeSecretStore } from "../../../../../contracts/internal/src/runtime/runtime-secret-store.ts";

import { MAX_DIAGNOSTIC_TEXT_LENGTH } from "../../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";

import type {
  ConnectionState,
  PiNativeConnection,
  PiNativeEvent,
  PiRequestInput,
} from "./connection-types.ts";
import type { PiProcessTransport } from "./process-transport.ts";
import type {
  PiCommand,
  PiCommandResult,
  PiCommandType,
  PiExtensionUiResponse,
  PiResponse,
  PiSuccessResponse,
} from "./schema.ts";

import {
  connectionError,
  NATIVE_EVENT_CAPACITY,
  PiNativeConnectionError,
  PiNativeConnectionErrorReason,
} from "./connection-types.ts";
import { makePiProcessTransport } from "./process-transport.ts";
import { reserveRequest } from "./request-reservation.ts";
import { PiCommandResultSchemas } from "./schema.ts";

type PiRequestFn = <Type extends PiRequestInput["type"]>(
  command: Extract<PiRequestInput, { type: Type }>
) => Effect.Effect<PiCommandResult<Type>, PiNativeConnectionError>;

type ConnectionRef = Ref.Ref<ConnectionState>;
type EventQueue = Queue.Queue<PiNativeEvent>;

// `PiRequestInput` is a request command with its `id` stripped, so re-attaching
// the id is all that is needed to reconstruct the command.
const attachCommandId = (command: PiRequestInput, id: string): PiCommand =>
  ({
    ...command,
    id,
  }) as PiCommand;

const decodeCommandResult = <Type extends PiCommandType>(
  type: Type,
  response: PiSuccessResponse
): Effect.Effect<PiCommandResult<Type>, PiNativeConnectionError> => {
  const data: unknown = "data" in response ? response.data : undefined;
  return Schema.decodeUnknownEffect(PiCommandResultSchemas[type])(data).pipe(
    Effect.mapError(() =>
      connectionError(
        PiNativeConnectionErrorReason.MalformedResponse,
        "Pi response data did not match the expected shape"
      )
    )
  );
};

const closeConnection = (
  state: ConnectionRef,
  error: PiNativeConnectionError
): Effect.Effect<boolean> =>
  Ref.modify(state, (current) =>
    Option.isSome(current.closed)
      ? ([Option.none(), current] as const)
      : ([
          Option.some(current.pending),
          {
            ...current,
            closed: Option.some(error),
            pending: new Map(),
          },
        ] as const)
  ).pipe(
    Effect.flatMap((pending) =>
      Option.match(pending, {
        onNone: () => Effect.succeed(false),
        onSome: (commands) =>
          Effect.forEach(commands.values(), ({ deferred }) =>
            Deferred.fail(deferred, error)
          ).pipe(Effect.as(true)),
      })
    )
  );

const makeShutdown = (
  state: ConnectionRef,
  events: EventQueue,
  transport: PiProcessTransport
): Effect.Effect<void> =>
  closeConnection(
    state,
    connectionError(
      PiNativeConnectionErrorReason.Shutdown,
      "Pi native connection is shut down"
    )
  ).pipe(
    Effect.flatMap((closed) =>
      closed
        ? Queue.shutdown(events).pipe(Effect.andThen(transport.close))
        : Effect.void
    ),
    Effect.ignore
  );

// A peer exit fails every in-flight request, but the event queue must also
// close so downstream consumers (the adapter's event loop) observe the end of
// stream and settle any awaiting prompt instead of blocking forever.
const handlePeerExit = ({
  transport,
  state,
  events,
  error,
}: {
  readonly transport: PiProcessTransport;
  readonly state: ConnectionRef;
  readonly events: EventQueue;
  readonly error: PiNativeConnectionError;
}): Effect.Effect<void> =>
  closeConnection(state, error).pipe(
    Effect.flatMap((closed) =>
      closed
        ? Queue.shutdown(events).pipe(Effect.andThen(transport.close))
        : Effect.void
    )
  );

const completeResponse = (
  state: ConnectionRef,
  response: PiResponse
): Effect.Effect<void> => {
  const { id } = response;
  if (id === undefined) {
    return Effect.void;
  }
  return Ref.modify(state, (current) => {
    const pending = current.pending.get(id);
    if (pending === undefined) {
      return [undefined, current] as const;
    }
    const next = new Map(current.pending);
    next.delete(id);
    return [
      pending,
      {
        ...current,
        pending: next,
      },
    ] as const;
  }).pipe(
    Effect.flatMap((pending) => {
      if (pending === undefined) {
        return Effect.void;
      }
      if (pending.command !== response.command) {
        return Deferred.fail(
          pending.deferred,
          connectionError(
            PiNativeConnectionErrorReason.MalformedResponse,
            "Pi response command did not match its request"
          )
        ).pipe(Effect.asVoid);
      }
      return Deferred.succeed(pending.deferred, response).pipe(Effect.asVoid);
    })
  );
};

const dropPending = (state: ConnectionRef, id: string): Effect.Effect<void> =>
  Ref.update(state, (current) => {
    if (!current.pending.has(id)) {
      return current;
    }
    const pending = new Map(current.pending);
    pending.delete(id);
    return {
      ...current,
      pending,
    };
  });

// Correlates responses back to their pending request and routes every other
// inbound value (session events, recovered unknowns, malformed records) to the
// event queue. Forked into the connection scope; a stream failure is treated as
// a peer exit.
const forkIncomingLoop = (
  state: ConnectionRef,
  events: EventQueue,
  transport: PiProcessTransport
): Effect.Effect<void> =>
  transport.incoming.pipe(
    Stream.runForEach((value) => {
      if ("_tag" in value) {
        return Queue.offer(events, value).pipe(Effect.asVoid);
      }
      return value.type === "response"
        ? completeResponse(state, value)
        : Queue.offer(events, value).pipe(Effect.asVoid);
    }),
    // Clean EOF and stream failure both mean the peer is gone. Only treating
    // failures as exits left in-flight prompts hanging when the child closed
    // stdout normally while exitCode observation lagged.
    Effect.matchEffect({
      onFailure: () =>
        handlePeerExit({
          transport,
          state,
          events,
          error: connectionError(
            PiNativeConnectionErrorReason.PeerExit,
            "Pi stdout stream failed"
          ),
        }),
      onSuccess: () =>
        handlePeerExit({
          transport,
          state,
          events,
          error: connectionError(
            PiNativeConnectionErrorReason.PeerExit,
            "Pi agent process exited"
          ),
        }),
    }),
    // Detached: interrupting a Bun stdout pull during scoped teardown can hang
    // forever, which would prevent finalizers (including shutdown) from running.
    Effect.forkDetach,
    Effect.asVoid
  );

const forkExitLoop = (
  state: ConnectionRef,
  events: EventQueue,
  transport: PiProcessTransport
): Effect.Effect<void> =>
  transport.exit.pipe(
    Effect.flatMap((code) =>
      handlePeerExit({
        transport,
        state,
        events,
        error: connectionError(
          PiNativeConnectionErrorReason.PeerExit,
          `Pi agent process exited with code ${code}`
        ),
      })
    ),
    Effect.catch(() =>
      handlePeerExit({
        transport,
        state,
        events,
        error: connectionError(
          PiNativeConnectionErrorReason.PeerExit,
          "Pi agent process exited before its status could be observed"
        ),
      })
    ),
    Effect.forkDetach,
    Effect.asVoid
  );

const makeRequest = (
  state: ConnectionRef,
  transport: PiProcessTransport
): PiRequestFn =>
  Effect.fn("PiNativeConnection.request")(function* <
    Type extends PiRequestInput["type"],
  >(command: Extract<PiRequestInput, { type: Type }>) {
    const deferred = yield* Deferred.make<
      PiResponse,
      PiNativeConnectionError
    >();
    const reservation = yield* reserveRequest(state, command, deferred);
    const id = yield* Result.match(reservation, {
      onFailure: Effect.fail,
      onSuccess: Effect.succeed,
    });
    yield* transport
      .send(attachCommandId(command, id))
      .pipe(
        Effect.mapError(() =>
          connectionError(
            PiNativeConnectionErrorReason.PeerExit,
            "Could not write Pi command"
          )
        )
      );
    // Interruption (e.g. a cancelled turn) leaves this request's slot in the
    // pending map; drop it so an interrupted request never accumulates until
    // peer-exit or shutdown reclaims the whole map.
    const response = yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() => dropPending(state, id))
    );
    if (!response.success) {
      // A well-formed failure response is domain data, not a transport fault:
      // keep Pi's own (bounded) error text and tag it as a command failure
      // rather than mislabelling it a malformed response.
      return yield* connectionError(
        PiNativeConnectionErrorReason.CommandFailed,
        response.error.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)
      );
    }
    return yield* decodeCommandResult(command.type, response);
  });

const makePiNativeConnectionFromTransport = Effect.fn(
  "PiNativeConnection.fromTransport"
)(function* (transport: PiProcessTransport) {
  const state = yield* Ref.make<ConnectionState>({
    closed: Option.none(),
    nextId: 1,
    pending: new Map(),
  });
  const events = yield* Queue.bounded<PiNativeEvent>(NATIVE_EVENT_CAPACITY);

  const shutdown = makeShutdown(state, events, transport);
  yield* Effect.addFinalizer(() => shutdown);
  yield* forkIncomingLoop(state, events, transport);
  yield* forkExitLoop(state, events, transport);

  const request = makeRequest(state, transport);

  return {
    abort: request({ type: "abort" }),
    events: Stream.fromQueue(events),
    exit: transport.exit,
    getClosed: Ref.get(state).pipe(Effect.map(({ closed }) => closed)),
    fork: (
      entryId: string
    ): Effect.Effect<
      { readonly cancelled: boolean; readonly text?: string },
      PiNativeConnectionError
    > =>
      request({
        entryId,
        type: "fork",
      }),
    getForkMessages: request({ type: "get_fork_messages" }),
    getState: request({ type: "get_state" }),
    getMessages: request({ type: "get_messages" }),
    newSession: request({ type: "new_session" }),
    prompt: (message: string): Effect.Effect<void, PiNativeConnectionError> =>
      request({
        message,
        type: "prompt",
      }),
    respondToExtensionUi: (
      response: PiExtensionUiResponse
    ): Effect.Effect<void, PiNativeConnectionError> =>
      transport
        .send(response)
        .pipe(
          Effect.mapError(() =>
            connectionError(
              PiNativeConnectionErrorReason.PeerExit,
              "Could not write Pi UI response"
            )
          )
        ),
    shutdown,
    stderr: transport.stderr,
    switchSession: (
      sessionPath: string
    ): Effect.Effect<
      { readonly cancelled: boolean },
      PiNativeConnectionError
    > =>
      request({
        sessionPath,
        type: "switch_session",
      }),
  };
});

const makePiNativeConnection = (
  config: PiAdapterConfig
): Effect.Effect<
  PiNativeConnection,
  PiCredentialError | PlatformError.PlatformError,
  ChildProcessSpawner | RuntimeSecretStore | Scope.Scope
> =>
  makePiProcessTransport(config).pipe(
    Effect.flatMap(makePiNativeConnectionFromTransport)
  );

export {
  makePiNativeConnection,
  makePiNativeConnectionFromTransport,
  PiNativeConnectionError,
  PiNativeConnectionErrorReason,
};
export type { PiNativeConnection, PiNativeEvent } from "./connection-types.ts";
