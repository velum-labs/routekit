import { Deferred, Effect, Option, Ref, Schema } from "effect";

import type { PiNativeConnection } from "../native/connection.ts";
import type { PiSessionRegistry } from "../session-registry.ts";
import type { AcpClientCorrelatedResult } from "../../../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AgentEventDiagnostic } from "../../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";
import type { PromptTurn } from "../../../../../engine/acp-adapter-kit/src/prompt-turn.ts";
import type {
  SessionLoadParams,
  SessionPromptParams,
  SessionResumeParams,
} from "../../../../../engine/acp-adapter-kit/src/session-requests.ts";
import type {
  AcpAgentConnectionShape,
  AcpClientRequestFailure,
} from "../../../../../engine/acp-agent/src/service.ts";

import {
  PiNativeConnectionError,
  PiNativeConnectionErrorReason,
} from "../native/connection.ts";
import { PiProtocolError } from "../native/protocol.ts";
import { PiCredentialError } from "../errors.ts";
import { runPromptTurn } from "../../../../../engine/acp-adapter-kit/src/prompt-turn.ts";
import {
  ACP_INTERNAL_ERROR_CODE,
  acpRequestFailure as failure,
  carriedFailureMessage,
} from "../../../../../engine/acp-adapter-kit/src/request-failure.ts";
import { makeInitializeResult } from "../../../../../engine/acp-adapter-kit/src/session-requests.ts";
import { PEER_EXIT_ERROR_CODE } from "../../../../../engine/acp-agent/src/connection/protocol.ts";

import { costFromHistory } from "./history-cost.ts";
import { logSessionMapping } from "./session-mapping.ts";
import { replaySession } from "./session-replay.ts";

const AGENT_LABEL = "Pi";
const SESSION_ID_BYTE_LENGTH = 16;
const HEX_RADIX = 16;

// Mint an opaque, ROUTEKIT_EVAL-owned ACP session id so Pi's native session id never
// leaves the adapter (ROUTEKIT_EVAL-423: keep native IDs private). The Node crypto module
// and its UUID helper are barred by the platform-access audit, so this mirrors
// the sanctioned `globalThis.crypto.getRandomValues` id generator used elsewhere
// in the runtime.
const makeSessionId = (): string => {
  const bytes = new Uint8Array(SESSION_ID_BYTE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes]
    .map((byte) => byte.toString(HEX_RADIX).padStart(2, "0"))
    .join("");
};

const isKnownPiError = (
  error: unknown
): error is PiCredentialError | PiNativeConnectionError | PiProtocolError =>
  error instanceof PiCredentialError ||
  error instanceof PiNativeConnectionError ||
  error instanceof PiProtocolError;

const isPeerExit = (error: unknown): boolean =>
  error instanceof PiNativeConnectionError &&
  error.reason === PiNativeConnectionErrorReason.PeerExit;

const errorMessage = (error: unknown): string =>
  isKnownPiError(error)
    ? error.detail
    : carriedFailureMessage(error, "Pi operation failed");

const asRequestFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, AcpClientRequestFailure, R> =>
  effect.pipe(
    Effect.mapError((error) =>
      failure(
        errorMessage(error),
        isPeerExit(error) ? PEER_EXIT_ERROR_CODE : ACP_INTERNAL_ERROR_CODE
      )
    )
  );

type PromptState = PromptTurn<
  { readonly message: string } | PiNativeConnectionError
>;

interface SessionRefs {
  readonly currentSession: Ref.Ref<Option.Option<string>>;
  readonly cumulativeCost: Ref.Ref<number>;
  readonly retryEntry: Ref.Ref<
    Option.Option<{
      readonly entryId: string;
      readonly prompt: string;
      readonly sessionId: string;
    }>
  >;
  readonly sessions: PiSessionRegistry;
}

interface HandlerContext {
  readonly activePrompt: Ref.Ref<Option.Option<PromptState>>;
  readonly agent: Deferred.Deferred<AcpAgentConnectionShape>;
  readonly cancelledSessions: Ref.Ref<readonly string[]>;
  readonly native: PiNativeConnection;
  readonly report: (diagnostic: AgentEventDiagnostic) => Effect.Effect<void>;
  readonly refs: SessionRefs;
}

// `sessionId` is the opaque, ROUTEKIT_EVAL-owned ACP session id; `sessionFile` is Pi's
// private native switch target and is never returned through ACP responses.
const rememberSession = (
  refs: SessionRefs,
  sessionId: string,
  sessionFile: string
): Effect.Effect<void> =>
  refs.sessions
    .set(sessionId, sessionFile)
    .pipe(Effect.andThen(Ref.set(refs.currentSession, Option.some(sessionId))));

const initializeResult: () => Effect.Effect<AcpClientCorrelatedResult> =
  makeInitializeResult("routekit-eval-pi");

const createSession = Effect.fn(function* ({ native, refs }: HandlerContext) {
  const created = yield* native.newSession;
  if (created.cancelled) {
    return yield* Effect.fail(failure("Pi session creation was cancelled"));
  }
  const state = yield* native.getState;
  const sessionId = yield* Effect.sync(makeSessionId);
  yield* Ref.set(refs.cumulativeCost, 0);
  yield* rememberSession(refs, sessionId, state.sessionFile ?? state.sessionId);
  logSessionMapping(state.sessionId, sessionId);
  return {
    method: "session/new" as const,
    result: { sessionId },
  };
}, asRequestFailure);

const restoreSession = Effect.fn(function* (
  { native, refs }: HandlerContext,
  params: SessionLoadParams
) {
  const sessionFile = yield* refs.sessions.get(params.sessionId);
  if (sessionFile === undefined) {
    // Never forward an unrecognized ACP session id to Pi as a native switch
    // target: it is client-supplied and would otherwise be interpreted as a
    // session-file path (ROUTEKIT_EVAL-423 keeps native IDs/paths adapter-private).
    return yield* Effect.fail(failure("Pi session is not known"));
  }
  const switched = yield* native.switchSession(sessionFile);
  if (switched.cancelled) {
    return yield* Effect.fail(failure("Pi session load was cancelled"));
  }
  const state = yield* native.getState;
  yield* rememberSession(
    refs,
    params.sessionId,
    state.sessionFile ?? state.sessionId
  );
  logSessionMapping(state.sessionId, params.sessionId);
  const history = yield* native.getMessages;
  // Pi persists per-message usage in loaded session history, so seed the
  // cumulative ACP cost instead of silently restarting it at zero.
  yield* Ref.set(refs.cumulativeCost, costFromHistory(history.messages));
  const lastMessage = history.messages.at(-1);
  const failedTail = Option.getOrUndefined(
    Schema.decodeUnknownOption(
      Schema.Struct({
        role: Schema.Literal("assistant"),
        stopReason: Schema.Literal("error"),
      })
    )(lastMessage)
  );
  if (failedTail === undefined) {
    yield* Ref.set(refs.retryEntry, Option.none());
  } else {
    const forkMessages = yield* native.getForkMessages;
    const candidate = forkMessages.messages.at(-1);
    yield* Ref.set(
      refs.retryEntry,
      candidate === undefined
        ? Option.none()
        : Option.some({
            entryId: candidate.entryId,
            prompt: candidate.text,
            sessionId: params.sessionId,
          })
    );
  }
  return history.messages;
});

const loadSession = Effect.fn(function* (
  context: HandlerContext,
  params: SessionLoadParams
) {
  const messages = yield* restoreSession(context, params);
  const connection = yield* Deferred.await(context.agent);
  yield* replaySession({
    connection,
    messages,
    report: context.report,
    sessionId: params.sessionId,
  });
  return {
    method: "session/load" as const,
    result: {},
  };
}, asRequestFailure);

const resumeSession = Effect.fn(function* (
  context: HandlerContext,
  params: SessionResumeParams
) {
  yield* restoreSession(context, params);
  return {
    method: "session/resume" as const,
    result: {},
  };
}, asRequestFailure);

const rollbackFailedPrompt = Effect.fn(function* (input: {
  readonly message: string;
  readonly native: PiNativeConnection;
  readonly refs: SessionRefs;
  readonly sessionId: string;
}) {
  const { message, native, refs, sessionId } = input;
  const retryEntry = yield* Ref.getAndSet(refs.retryEntry, Option.none());
  if (
    Option.isNone(retryEntry) ||
    retryEntry.value.sessionId !== sessionId ||
    retryEntry.value.prompt !== message
  ) {
    return;
  }
  const forked = yield* native.fork(retryEntry.value.entryId);
  if (forked.cancelled) {
    return yield* Effect.fail(
      failure("Pi failed to roll back the previous failed prompt")
    );
  }
  const state = yield* native.getState;
  yield* rememberSession(refs, sessionId, state.sessionFile ?? state.sessionId);
});

const runPrompt = Effect.fn(function* (
  { activePrompt, cancelledSessions, native, refs }: HandlerContext,
  params: SessionPromptParams
) {
  return yield* runPromptTurn({
    activePrompt,
    agentLabel: AGENT_LABEL,
    // Pi alone rolls a previously failed prompt back before re-sending it, so
    // the retry lands on a session forked at the failed entry.
    beforeSend: ({ message, sessionId }) =>
      rollbackFailedPrompt({
        message,
        native,
        refs,
        sessionId,
      }),
    cancelledSessions,
    currentSession: refs.currentSession,
    native,
    params,
  });
}, asRequestFailure);

export {
  createSession,
  errorMessage,
  initializeResult,
  loadSession,
  replaySession,
  resumeSession,
  runPrompt,
};
export type { HandlerContext, PromptState, SessionRefs };
