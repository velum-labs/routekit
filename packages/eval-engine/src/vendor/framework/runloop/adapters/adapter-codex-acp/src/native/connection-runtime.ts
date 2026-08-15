import type { Scope } from "effect";

import { Data, Deferred, Effect, Queue, Ref, Schema, Stream } from "effect";

import { MAX_DIAGNOSTIC_TEXT_LENGTH } from "../../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";

import type { CodexCommandResult, CodexRequestMethod } from "./command-schema.ts";
import type { CodexProcessTransport } from "./process-transport.ts";
import type { CodexMalformedLine, CodexUnknownEvent } from "./protocol.ts";
import type {
  CodexAskUserRequest,
  CodexKnownSessionEvent,
  CodexRequestCommand,
  CodexResponse,
  CodexUnknownRequest,
} from "./schema.ts";

import { CodexCommandResultSchemas } from "./command-schema.ts";
import { encodeCodexRequestError } from "./protocol.ts";

const CodexNativeConnectionErrorReason = {
  CommandFailed: "command-failed",
  MalformedResponse: "malformed-response",
  PeerExit: "peer-exit",
  Shutdown: "shutdown",
} as const;
type CodexNativeConnectionErrorReason =
  (typeof CodexNativeConnectionErrorReason)[keyof typeof CodexNativeConnectionErrorReason];

class CodexNativeConnectionError extends Data.TaggedError(
  "CodexNativeConnectionError"
)<{
  readonly detail: string;
  readonly reason: CodexNativeConnectionErrorReason;
}> {}

type CodexNativeEvent =
  | CodexAskUserRequest
  | CodexKnownSessionEvent
  | CodexMalformedLine
  | CodexUnknownEvent;
type CodexIncomingValue =
  | CodexAskUserRequest
  | CodexKnownSessionEvent
  | CodexMalformedLine
  | CodexResponse
  | CodexUnknownEvent
  | CodexUnknownRequest;

type CodexRequestFn = <Method extends CodexRequestMethod>(
  command: Extract<CodexRequestCommand, { readonly method: Method }>
) => Effect.Effect<CodexCommandResult<Method>, CodexNativeConnectionError>;

interface PendingCommand {
  readonly deferred: Deferred.Deferred<
    CodexResponse,
    CodexNativeConnectionError
  >;
  readonly method: CodexRequestMethod;
}

interface ConnectionState {
  readonly closed: boolean;
  readonly nextId: number;
  readonly pending: ReadonlyMap<number, PendingCommand>;
  readonly shutdown: boolean;
}

type ConnectionRef = Ref.Ref<ConnectionState>;
type EventQueue = Queue.Queue<CodexNativeEvent>;

const connectionError = (
  reason: CodexNativeConnectionErrorReason,
  detail: string
): CodexNativeConnectionError =>
  new CodexNativeConnectionError({
    detail,
    reason,
  });

const decodeCommandResult = <Method extends CodexRequestMethod>(
  method: Method,
  response: CodexResponse
): Effect.Effect<CodexCommandResult<Method>, CodexNativeConnectionError> => {
  if ("error" in response) {
    return Effect.fail(
      connectionError(
        CodexNativeConnectionErrorReason.CommandFailed,
        response.error.message.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)
      )
    );
  }
  return Schema.decodeUnknownEffect(CodexCommandResultSchemas[method])(
    response.result
  ).pipe(
    Effect.mapError(() =>
      connectionError(
        CodexNativeConnectionErrorReason.MalformedResponse,
        "Codex response data did not match the expected shape"
      )
    )
  );
};

const failPending = (
  state: ConnectionRef,
  error: CodexNativeConnectionError
): Effect.Effect<void> =>
  Ref.modify(
    state,
    (current) =>
      [
        current.pending,
        {
          ...current,
          closed: true,
          pending: new Map(),
        },
      ] as const
  ).pipe(
    Effect.flatMap((pending) =>
      Effect.forEach(pending.values(), ({ deferred }) =>
        Deferred.fail(deferred, error)
      )
    ),
    Effect.asVoid
  );

const makeShutdown = (
  state: ConnectionRef,
  events: EventQueue,
  transport: CodexProcessTransport
): Effect.Effect<void> =>
  Ref.modify(
    state,
    (current) =>
      [
        current.shutdown,
        {
          ...current,
          closed: true,
          shutdown: true,
        },
      ] as const
  ).pipe(
    Effect.flatMap((wasClosed) =>
      wasClosed
        ? Effect.void
        : failPending(
            state,
            connectionError(
              CodexNativeConnectionErrorReason.Shutdown,
              "Codex native connection is shut down"
            )
          ).pipe(
            Effect.andThen(Queue.shutdown(events)),
            Effect.andThen(transport.close)
          )
    ),
    Effect.ignore
  );

const handlePeerExit = (
  state: ConnectionRef,
  events: EventQueue,
  error: CodexNativeConnectionError
): Effect.Effect<void> =>
  failPending(state, error).pipe(Effect.andThen(Queue.shutdown(events)));

const completeResponse = (
  state: ConnectionRef,
  response: CodexResponse
): Effect.Effect<void> => {
  const { id } = response;
  if (typeof id !== "number") {
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
    Effect.flatMap((pending) =>
      pending === undefined
        ? Effect.void
        : Deferred.succeed(pending.deferred, response).pipe(Effect.asVoid)
    )
  );
};

const dropPending = (state: ConnectionRef, id: number): Effect.Effect<void> =>
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

const answerUnknownRequest = (
  transport: CodexProcessTransport,
  request: CodexUnknownRequest
): Effect.Effect<void> =>
  transport
    .write(
      encodeCodexRequestError(
        request.id,
        `Codex method is not supported: ${request.method}`
      )
    )
    .pipe(Effect.ignore);

const isRecoveredDiagnostic = (
  value: CodexIncomingValue
): value is CodexMalformedLine | CodexUnknownEvent => "_tag" in value;

const isResponse = (value: CodexIncomingValue): value is CodexResponse =>
  !("method" in value);

const isAskUserRequest = (
  value: CodexAskUserRequest | CodexUnknownRequest
): value is CodexAskUserRequest => "params" in value;

const forkIncomingLoop = (
  state: ConnectionRef,
  events: EventQueue,
  transport: CodexProcessTransport
): Effect.Effect<void, never, Scope.Scope> =>
  transport.incoming.pipe(
    Stream.runForEach((value) => {
      if (isRecoveredDiagnostic(value)) {
        return Queue.offer(events, value).pipe(Effect.asVoid);
      }
      if (isResponse(value)) {
        return completeResponse(state, value);
      }
      if ("id" in value) {
        return isAskUserRequest(value)
          ? Queue.offer(events, value).pipe(Effect.asVoid)
          : answerUnknownRequest(transport, value);
      }
      return Queue.offer(events, value).pipe(Effect.asVoid);
    }),
    Effect.catch(() =>
      handlePeerExit(
        state,
        events,
        connectionError(
          CodexNativeConnectionErrorReason.PeerExit,
          "Codex stdout stream failed"
        )
      )
    ),
    Effect.forkScoped,
    Effect.asVoid
  );

const forkExitLoop = (
  state: ConnectionRef,
  events: EventQueue,
  transport: CodexProcessTransport
): Effect.Effect<void, never, Scope.Scope> =>
  transport.exit.pipe(
    Effect.flatMap((code) =>
      handlePeerExit(
        state,
        events,
        connectionError(
          CodexNativeConnectionErrorReason.PeerExit,
          `Codex process exited with code ${code}`
        )
      )
    ),
    Effect.catch(() =>
      handlePeerExit(
        state,
        events,
        connectionError(
          CodexNativeConnectionErrorReason.PeerExit,
          "Codex process exit could not be observed"
        )
      )
    ),
    Effect.forkScoped,
    Effect.asVoid
  );

const makeRequest = (
  state: ConnectionRef,
  transport: CodexProcessTransport
): CodexRequestFn =>
  Effect.fn("CodexNativeConnection.request")(function* <
    Method extends CodexRequestMethod,
  >(command: Extract<CodexRequestCommand, { readonly method: Method }>) {
    const deferred = yield* Deferred.make<
      CodexResponse,
      CodexNativeConnectionError
    >();
    const id = yield* Ref.modify(state, (current) => {
      if (current.closed) {
        return [undefined, current] as const;
      }
      const { nextId } = current;
      const pending = new Map(current.pending).set(nextId, {
        deferred,
        method: command.method,
      });
      return [
        nextId,
        {
          ...current,
          nextId: current.nextId + 1,
          pending,
        },
      ] as const;
    });
    if (id === undefined) {
      return yield* connectionError(
        CodexNativeConnectionErrorReason.Shutdown,
        "Codex native connection is shut down"
      );
    }
    yield* transport
      .send(id, command)
      .pipe(
        Effect.mapError(() =>
          connectionError(
            CodexNativeConnectionErrorReason.PeerExit,
            "Could not write Codex command"
          )
        )
      );
    const response = yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() => dropPending(state, id))
    );
    return yield* decodeCommandResult(command.method, response);
  });

export {
  CodexNativeConnectionError,
  connectionError,
  forkExitLoop,
  forkIncomingLoop,
  makeRequest,
  makeShutdown,
};
export type { CodexNativeEvent, CodexRequestFn, ConnectionState, EventQueue };
