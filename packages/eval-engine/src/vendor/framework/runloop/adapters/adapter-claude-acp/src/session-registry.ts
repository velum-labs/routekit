import { Effect } from "effect";

import { ClaudeSessionStateError } from "./errors.ts";

const MAX_RETAINED_CLAUDE_SESSIONS = 64;

/**
 * The ACP session ids this adapter minted, in least-recently-used order. It is
 * the whole basis of the `session/load` and `session/resume` guard: an id that
 * is not in here is client-supplied and must never reach Claude's `--resume`.
 */
interface ClaudeSessionRegistry {
  readonly has: (sessionId: string) => Effect.Effect<boolean>;
  readonly remember: (sessionId: string) => Effect.Effect<void>;
}

const makeClaudeSessionRegistry = (
  initial: readonly string[] = []
): ClaudeSessionRegistry => {
  const sessions = new Set(initial);
  return {
    has: (sessionId) => Effect.sync(() => sessions.has(sessionId)),
    remember: (sessionId) =>
      Effect.sync(() => {
        sessions.delete(sessionId);
        sessions.add(sessionId);
        while (sessions.size > MAX_RETAINED_CLAUDE_SESSIONS) {
          const oldest = sessions.values().next();
          if (oldest.done === true) {
            break;
          }
          sessions.delete(oldest.value);
        }
      }),
  };
};

/**
 * The registry's durable projection. Claude's ACP session id *is* its native
 * `--resume` target, so the captured state carries no native path: it is the id
 * itself, a marker that this adapter minted the session through `session/new`.
 * `restore` re-seeds the registry for a resource rebuilt from an ownership
 * record, so a resume the record vouches for succeeds in a process that never
 * created the session while every other id still fails the guard.
 */
interface ClaudeSessionState {
  readonly capture: (sessionId: string) => Effect.Effect<string | undefined>;
  readonly restore: (input: {
    readonly sessionId: string;
    readonly state: string;
  }) => Effect.Effect<void, ClaudeSessionStateError>;
}

const makeClaudeSessionState = (
  sessions: ClaudeSessionRegistry
): ClaudeSessionState => ({
  capture: (sessionId): Effect.Effect<string | undefined> =>
    sessions
      .has(sessionId)
      .pipe(Effect.map((known) => (known ? sessionId : undefined))),
  restore: ({
    sessionId,
    state,
  }): Effect.Effect<void, ClaudeSessionStateError> =>
    state === sessionId
      ? sessions.remember(sessionId)
      : Effect.fail(
          new ClaudeSessionStateError({
            detail: `Stored Claude state for session ${sessionId} does not name that session`,
          })
        ),
});

export { makeClaudeSessionRegistry, makeClaudeSessionState };
export type { ClaudeSessionRegistry, ClaudeSessionState };
