import { Effect } from "effect";

import { PiSessionStateError } from "./errors.ts";

const MAX_RETAINED_PI_SESSIONS = 64;

interface PiSessionRegistry {
  readonly get: (sessionId: string) => Effect.Effect<string | undefined>;
  readonly set: (sessionId: string, sessionFile: string) => Effect.Effect<void>;
}

const makePiSessionRegistry = (
  initial: readonly (readonly [string, string])[] = []
): PiSessionRegistry => {
  const sessions = new Map(initial);
  return {
    get: (sessionId) =>
      Effect.sync(() => {
        const sessionFile = sessions.get(sessionId);
        if (sessionFile !== undefined) {
          sessions.delete(sessionId);
          sessions.set(sessionId, sessionFile);
        }
        return sessionFile;
      }),
    set: (sessionId, sessionFile) =>
      Effect.sync(() => {
        sessions.delete(sessionId);
        sessions.set(sessionId, sessionFile);
        while (sessions.size > MAX_RETAINED_PI_SESSIONS) {
          const oldest = sessions.keys().next();
          if (oldest.done === true) {
            break;
          }
          sessions.delete(oldest.value);
        }
      }),
  };
};

/**
 * The registry's durable projection. `capture` hands the runtime the session
 * file Pi recorded for an ACP session so it can be stored opaquely in the
 * ownership record; `restore` puts it back so a `session/load` or
 * `session/resume` resolves in a process that never created the session.
 *
 * The value is Pi's private native target, so nothing above this adapter may
 * decode it (ROUTEKIT_EVAL-423 keeps native paths adapter-private).
 */
interface PiSessionState {
  readonly capture: (sessionId: string) => Effect.Effect<string | undefined>;
  readonly restore: (input: {
    readonly sessionId: string;
    readonly state: string;
  }) => Effect.Effect<void, PiSessionStateError>;
}

const makePiSessionState = (sessions: PiSessionRegistry): PiSessionState => ({
  capture: (sessionId): Effect.Effect<string | undefined> =>
    sessions.get(sessionId),
  restore: ({ sessionId, state }): Effect.Effect<void, PiSessionStateError> =>
    state.trim().length === 0
      ? Effect.fail(
          new PiSessionStateError({
            detail: `Stored Pi state for session ${sessionId} names no session file`,
          })
        )
      : sessions.set(sessionId, state),
});

export { makePiSessionRegistry, makePiSessionState };
export type { PiSessionRegistry, PiSessionState };
