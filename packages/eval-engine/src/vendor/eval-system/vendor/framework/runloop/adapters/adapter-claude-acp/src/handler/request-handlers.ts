import { Deferred, Effect, Option, Ref, Schema } from "effect";

import type {
  ClaudeNativeConnection,
  ClaudeTranscriptMessage,
} from "../native/connection.ts";
import type { ClaudeSessionRegistry } from "../session-registry.ts";
import type { AcpClientCorrelatedResult } from "../../../../../contracts/internal/src/acp/protocol/profile.ts";
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

import { runPromptTurn } from "../../../../../engine/acp-adapter-kit/src/prompt-turn.ts";
import {
  acpRequestFailure as failure,
  carriedFailureMessage,
} from "../../../../../engine/acp-adapter-kit/src/request-failure.ts";
import { makeInitializeResult } from "../../../../../engine/acp-adapter-kit/src/session-requests.ts";

const AGENT_LABEL = "Claude";

// Claude's domain errors are `Data.TaggedError` values that carry the
// human-facing reason on `detail`; a settled prompt failure carries it on
// `message` (see `finishPrompt`). Both are recovered by decoding the carrying
// shape at this boundary instead of hand-narrowing `"detail" in error`.
const CarriedDetail = Schema.Struct({ detail: Schema.String });
const decodeCarriedDetail = Schema.decodeUnknownOption(CarriedDetail);

const errorMessage = (error: unknown): string =>
  Option.match(decodeCarriedDetail(error), {
    onNone: () => carriedFailureMessage(error, "Claude operation failed"),
    onSome: ({ detail }) => detail,
  });

const asRequestFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, AcpClientRequestFailure, R> =>
  effect.pipe(Effect.mapError((error) => failure(errorMessage(error))));

type PromptState = PromptTurn<{ readonly message: string }>;

interface SessionRefs {
  readonly currentSession: Ref.Ref<Option.Option<string>>;
  readonly sessions: ClaudeSessionRegistry;
}

interface HandlerContext {
  readonly activePrompt: Ref.Ref<Option.Option<PromptState>>;
  readonly agent: Deferred.Deferred<AcpAgentConnectionShape>;
  readonly cancelledSessions: Ref.Ref<readonly string[]>;
  readonly native: ClaudeNativeConnection;
  readonly refs: SessionRefs;
}

const rememberSession = (
  refs: SessionRefs,
  sessionId: string
): Effect.Effect<void> =>
  refs.sessions
    .remember(sessionId)
    .pipe(Effect.andThen(Ref.set(refs.currentSession, Option.some(sessionId))));

// session/new and session/load both respawn the native process, which tears
// down the drain feeding the current turn. Refuse them while a prompt is in
// flight so a well-behaved client gets a clear error instead of silently
// resetting its own turn. This is a best-effort check-then-act: requests run
// concurrently, so a switch admitted in the same instant as a prompt still
// races, but the prompt's own run teardown (see `makeRun`) settles the `done`
// deferred either way, so the worst case is a spurious failure, not a lost turn.
const ensureNoActivePrompt = (
  activePrompt: Ref.Ref<Option.Option<PromptState>>
): Effect.Effect<void, AcpClientRequestFailure> =>
  Ref.get(activePrompt).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: () =>
          Effect.fail(
            failure(
              "Claude has an active prompt; cancel it before switching sessions"
            )
          ),
      })
    )
  );

const initializeResult: () => Effect.Effect<AcpClientCorrelatedResult> =
  makeInitializeResult("routekit-eval-claude");

const createSession = Effect.fn(function* ({
  activePrompt,
  native,
  refs,
}: HandlerContext) {
  yield* ensureNoActivePrompt(activePrompt);
  const created = yield* native.newSession;
  if (created.cancelled) {
    return yield* Effect.fail(failure("Claude session creation was cancelled"));
  }
  const state = yield* native.getState;
  yield* rememberSession(refs, state.sessionId);
  return {
    method: "session/new" as const,
    result: { sessionId: state.sessionId },
  };
}, asRequestFailure);

const replaySession = Effect.fn(function* (
  connection: AcpAgentConnectionShape,
  sessionId: string,
  messages: readonly ClaudeTranscriptMessage[]
) {
  for (const message of messages) {
    if (message.content.length === 0) {
      continue;
    }
    const sessionUpdate =
      message.role === "user" ? "user_message_chunk" : "agent_message_chunk";
    yield* connection.notify("session/update", {
      sessionId,
      update: {
        content: {
          text: message.content,
          type: "text",
        },
        sessionUpdate,
      },
    });
  }
});

const restoreSession = Effect.fn(function* (
  { activePrompt, native, refs }: HandlerContext,
  params: SessionLoadParams
) {
  yield* ensureNoActivePrompt(activePrompt);
  const known = yield* refs.sessions.has(params.sessionId);
  if (!known) {
    // Never forward an unrecognized ACP session id to Claude as a --resume
    // target: it is client-supplied and native session ids are adapter-private
    // (ROUTEKIT_EVAL-405 parity with the Pi adapter's session/load rejection). A session
    // an ownership record vouches for is re-seeded into the registry through
    // `restoreState` before the resume reaches here (ROUTEKIT_EVAL-442).
    return yield* Effect.fail(failure("Claude session is not known"));
  }
  const switched = yield* native.switchSession(params.sessionId);
  if (switched.cancelled) {
    return yield* Effect.fail(failure("Claude session load was cancelled"));
  }
  const state = yield* native.getState;
  yield* rememberSession(refs, state.sessionId);
  const history = yield* native.getMessages;
  return {
    sessionId: state.sessionId,
    messages: history.messages,
  };
});

const loadSession = Effect.fn(function* (
  context: HandlerContext,
  params: SessionLoadParams
) {
  const { messages, sessionId } = yield* restoreSession(context, params);
  const connection = yield* Deferred.await(context.agent);
  yield* replaySession(connection, sessionId, messages);
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

const runPrompt = Effect.fn(function* (
  { activePrompt, cancelledSessions, native, refs }: HandlerContext,
  params: SessionPromptParams
) {
  return yield* runPromptTurn({
    activePrompt,
    agentLabel: AGENT_LABEL,
    beforeSend: () => Effect.void,
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
  resumeSession,
  runPrompt,
};
export type { HandlerContext, PromptState, SessionRefs };
