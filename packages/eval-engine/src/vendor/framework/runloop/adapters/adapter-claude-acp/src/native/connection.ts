import type { PlatformError, Redacted } from "effect";

import {
  Crypto,
  Effect,
  Fiber,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import type {
  ClaudeNativeConnection,
  ClaudeNativeEvent,
  ConnectionCore,
  ConnectionRef,
  ConnectionResult,
  ConnectionState,
  EventQueue,
  StartProcessFn,
  StartupInput,
} from "./connection-types.ts";
import type { ClaudeProcess } from "./process-transport.ts";
import type { ClaudeMalformedLine, ClaudeUnknownEvent } from "./protocol.ts";
import type { AskUserControlResponseType, ClaudeInbound } from "./schema.ts";
import type { ClaudeTranscriptMessage } from "./transcript.ts";
import type { ClaudeAdapterConfig } from "../config.ts";

import {
  AGENT_END,
  ClaudeNativeConnectionErrorReason,
  connectionError,
  NATIVE_EVENT_CAPACITY,
} from "./connection-types.ts";
import {
  resolveCredential,
  spawnClaudeProcess,
  verifyClaudeVersion,
} from "./process-transport.ts";
import { recordAgentText, recordMessage } from "./transcript.ts";

// Shut the shared queue only while this process is still the active peer. The
// connection is marked closed *before* the queue is shut so a session opened
// after the peer dies observes `closed` and fails fast instead of spawning a
// process whose events can never reach the already-ended run loop.
const endOfStream = (
  state: ConnectionRef,
  events: EventQueue,
  process: ClaudeProcess
): Effect.Effect<void> =>
  Ref.get(state).pipe(
    Effect.flatMap((current) =>
      Option.isSome(current.active) && current.active.value === process
        ? Ref.update(state, (previous) => ({
            ...previous,
            closed: true,
          })).pipe(Effect.andThen(Queue.shutdown(events)))
        : Effect.void
    )
  );

const offerInbound = (
  events: EventQueue,
  value: ClaudeInbound | ClaudeMalformedLine | ClaudeUnknownEvent
): Effect.Effect<void> => {
  if ("_tag" in value) {
    return Queue.offer(events, value).pipe(Effect.asVoid);
  }
  return value.type === "result"
    ? Queue.offer(events, value).pipe(
        Effect.andThen(Queue.offer(events, AGENT_END)),
        Effect.asVoid
      )
    : Queue.offer(events, value).pipe(Effect.asVoid);
};

// Drains one process's stdout into the shared queue (result -> AGENT_END).
const drainProcess = (
  core: ConnectionCore,
  process: ClaudeProcess
): Effect.Effect<void> =>
  process.incoming.pipe(
    Stream.runForEach((value) =>
      ("_tag" in value
        ? Effect.void
        : recordAgentText(core.transcripts, process.sessionId, value)
      ).pipe(Effect.andThen(offerInbound(core.events, value)))
    ),
    Effect.ensuring(endOfStream(core.state, core.events, process)),
    Effect.ignore
  );

// Forwards one process's stderr into the connection-lived stderr queue. Each
// spawn forks this into the connection scope, so the composition root's single
// drain surfaces the stderr of every process, not just the first one active.
const drainStderr = (
  stderr: Queue.Queue<Uint8Array>,
  child: ClaudeProcess
): Effect.Effect<void> =>
  child.stderr.pipe(
    Stream.runForEach((chunk) => Queue.offer(stderr, chunk)),
    Effect.ignore
  );

// Resolves the active process or fails as no-active-session, mapping any use
// error to peer-exit. Read-only uses never fail, so their value is unchanged.
const withActive = <A, E>(
  state: ConnectionRef,
  use: (process: ClaudeProcess) => Effect.Effect<A, E>
): ConnectionResult<A> =>
  Ref.get(state).pipe(
    Effect.flatMap((current) =>
      Option.match(current.active, {
        onNone: () =>
          Effect.fail(
            connectionError(
              ClaudeNativeConnectionErrorReason.NoActiveSession,
              "Claude has no active session"
            )
          ),
        onSome: (process) =>
          use(process).pipe(
            Effect.mapError(() =>
              connectionError(
                ClaudeNativeConnectionErrorReason.PeerExit,
                "Could not write to the Claude process"
              )
            )
          ),
      })
    )
  );

// Reads a value from the active process, falling back to a default (no failure)
// when there is no active process.
const foldActive = <A>(
  state: ConnectionRef,
  onNone: A,
  onSome: (process: ClaudeProcess) => A
): Effect.Effect<A> =>
  Ref.get(state).pipe(
    Effect.map((current) =>
      Option.match(current.active, {
        onNone: () => onNone,
        onSome,
      })
    )
  );

const makeShutdown = (core: ConnectionCore): Effect.Effect<void> =>
  Ref.modify(core.state, (current) => [
    current,
    {
      ...current,
      active: Option.none(),
      closed: true,
      drain: Option.none(),
    },
  ]).pipe(
    Effect.flatMap((previous) => {
      // The forkScoped drain is interrupted by the connection scope, not here.
      if (previous.closed && Option.isNone(previous.active)) {
        return Effect.void;
      }
      return Option.match(previous.active, {
        onNone: () => Effect.void,
        onSome: (process) => process.close,
      }).pipe(
        Effect.andThen(Queue.shutdown(core.events)),
        Effect.andThen(Queue.shutdown(core.stderr))
      );
    }),
    Effect.ignore
  );

const makePrompt =
  (core: ConnectionCore) =>
  (message: string): ConnectionResult<void> =>
    withActive(core.state, (process) =>
      recordMessage(core.transcripts, process.sessionId, {
        content: message,
        role: "user",
      }).pipe(
        Effect.andThen(
          process.send({
            message: {
              content: message,
              role: "user",
            },
            parent_tool_use_id: null,
            session_id: process.sessionId,
            type: "user",
          })
        )
      )
    );

// A session create/resume settles to `{ cancelled: false }`; a spawn failure is
// reported as peer-exit.
const asSwitchResult = <E>(
  effect: Effect.Effect<ClaudeProcess, E>,
  detail: string
): ConnectionResult<{ readonly cancelled: boolean }> =>
  effect.pipe(
    Effect.as({ cancelled: false }),
    Effect.mapError(() =>
      connectionError(ClaudeNativeConnectionErrorReason.PeerExit, detail)
    )
  );

const buildConnection = (
  core: ConnectionCore,
  newSessionId: Effect.Effect<string, PlatformError.PlatformError>,
  startProcess: StartProcessFn
): ClaudeNativeConnection => ({
  abort: withActive(core.state, (process) =>
    newSessionId.pipe(
      Effect.flatMap((id) =>
        process.send({
          request: { subtype: "interrupt" },
          request_id: `ori-${id}`,
          type: "control_request",
        })
      )
    )
  ),
  events: Stream.fromQueue(core.events),
  exit: Effect.flatten(
    foldActive(core.state, Effect.succeed(0), (child) => child.exit)
  ),
  getMessages: withActive(core.state, (process) =>
    Ref.get(core.transcripts).pipe(
      Effect.map((known) => ({ messages: known.get(process.sessionId) ?? [] }))
    )
  ),
  getState: withActive(core.state, (process) =>
    Effect.succeed({
      autoCompactionEnabled: true,
      sessionId: process.sessionId,
    })
  ),
  newSession: asSwitchResult(
    newSessionId.pipe(
      Effect.flatMap((sessionId) =>
        startProcess({
          sessionId,
          type: "create",
        })
      )
    ),
    "Could not start a Claude session"
  ),
  prompt: makePrompt(core),
  respondToAskUser: (
    response: AskUserControlResponseType
  ): ConnectionResult<void> =>
    withActive(core.state, (process) => process.send(response)),
  shutdown: makeShutdown(core),
  stderr: Stream.fromQueue(core.stderr),
  switchSession: (
    sessionId: string
  ): ConnectionResult<{ readonly cancelled: boolean }> =>
    asSwitchResult(
      startProcess({
        sessionId,
        type: "load",
      }),
      "Could not resume a Claude session"
    ),
});

interface StartProcessDeps {
  readonly adapterConfig: ClaudeAdapterConfig;
  readonly core: ConnectionCore;
  readonly credential: Redacted.Redacted;
  readonly scope: Scope.Scope;
  readonly spawner: (typeof ChildProcessSpawner)["Service"];
}

// Respawns Claude for a session create/resume, forking its drain into the
// connection scope and interrupting/closing the superseded process.
const makeStartProcess = ({
  adapterConfig,
  core,
  credential,
  scope,
  spawner,
}: StartProcessDeps): StartProcessFn =>
  Effect.fn("ClaudeNativeConnection.startProcess")(
    function* (startup: StartupInput) {
      // A prior peer death permanently shut the shared queue and ended the run
      // loop, so a process spawned now could deliver no events; fail fast with
      // a clear peer-exit instead of returning a session that would hang.
      const current = yield* Ref.get(core.state);
      if (current.closed) {
        return yield* connectionError(
          ClaudeNativeConnectionErrorReason.PeerExit,
          "Claude connection is closed after the peer exited"
        );
      }
      const spawned = yield* spawnClaudeProcess({
        adapterConfig,
        credential,
        startup,
      });
      const drain = yield* Effect.forkScoped(drainProcess(core, spawned));
      yield* Effect.forkScoped(drainStderr(core.stderr, spawned));
      const previous = yield* Ref.getAndSet(core.state, {
        active: Option.some(spawned),
        closed: false,
        drain: Option.some(drain),
      });
      yield* Effect.andThen(
        Option.match(previous.drain, {
          onNone: () => Effect.void,
          onSome: (fiber) => Fiber.interrupt(fiber),
        }),
        Option.match(previous.active, {
          onNone: () => Effect.void,
          onSome: (child) => child.close,
        })
      );
      return spawned;
    },
    (effect) =>
      effect.pipe(
        Effect.provideService(ChildProcessSpawner, spawner),
        Effect.provideService(Scope.Scope, scope)
      )
  );

const makeClaudeNativeConnection = Effect.fn("ClaudeNativeConnection.make")(
  function* (adapterConfig: ClaudeAdapterConfig) {
    // Version gate strictly before any credential read.
    yield* verifyClaudeVersion(adapterConfig.claudeCommand);
    const credential = yield* resolveCredential;
    const crypto = yield* Crypto.Crypto;
    const newSessionId = crypto.randomUUIDv4;
    const spawner = yield* ChildProcessSpawner;
    const scope = yield* Effect.scope;

    const core: ConnectionCore = {
      events: yield* Queue.bounded<ClaudeNativeEvent>(NATIVE_EVENT_CAPACITY),
      state: yield* Ref.make<ConnectionState>({
        active: Option.none(),
        closed: false,
        drain: Option.none(),
      }),
      // Dropping so a stalled log sink can never back-pressure a child's stderr.
      stderr: yield* Queue.dropping<Uint8Array>(NATIVE_EVENT_CAPACITY),
      transcripts: yield* Ref.make<
        ReadonlyMap<string, readonly ClaudeTranscriptMessage[]>
      >(new Map()),
    };

    const startProcess = makeStartProcess({
      adapterConfig,
      core,
      credential,
      scope,
      spawner,
    });
    const connection = buildConnection(core, newSessionId, startProcess);
    yield* Effect.addFinalizer(() => connection.shutdown);
    return connection;
  }
);

export { makeClaudeNativeConnection };
export {
  ClaudeNativeConnectionError,
  ClaudeNativeConnectionErrorReason,
} from "./connection-types.ts";
export type {
  ClaudeNativeConnection,
  ClaudeNativeEvent,
} from "./connection-types.ts";
export type { ClaudeTranscriptMessage } from "./transcript.ts";
