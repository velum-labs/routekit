import { Context, Effect, Layer, Option, Ref, Schema } from "effect";

import type { SessionOwnershipRecord } from "../../../contracts/internal/src/runtime/session-ownership.ts";

/**
 * A durable ownership write that did not land. Distinct from missing ownership:
 * a caller can retry this, and creation must not hand back a session ID whose
 * mapping failed to persist.
 */
class SessionOwnershipPersistenceError extends Schema.TaggedErrorClass<SessionOwnershipPersistenceError>()(
  "SessionOwnershipPersistenceError",
  {
    detail: Schema.String,
    sessionId: Schema.String,
  }
) {}

interface SessionOwnershipStoreShape {
  /**
   * Resolves the record for a session, or `None` when there is none to resolve.
   *
   * An undecodable record reads as `None` rather than as a failure: RFC 0003
   * makes a corrupt record indistinguishable from a missing one for resolution,
   * so it can never be repaired by guessing. A read that fails for any other
   * reason is a persistence failure, because "the disk refused" and "this
   * session does not exist" do not share a remedy.
   */
  readonly read: (
    sessionId: string
  ) => Effect.Effect<
    Option.Option<SessionOwnershipRecord>,
    SessionOwnershipPersistenceError
  >;
  readonly remove: (
    sessionId: string
  ) => Effect.Effect<void, SessionOwnershipPersistenceError>;
  readonly write: (
    record: SessionOwnershipRecord
  ) => Effect.Effect<void, SessionOwnershipPersistenceError>;
}

class SessionOwnershipStore extends Context.Service<
  SessionOwnershipStore,
  SessionOwnershipStoreShape
>()("routekit-eval/selected-adapter/SessionOwnershipStore") {}

/**
 * Ownership held for one process lifetime.
 *
 * This is the pre-RFC-0003 behavior kept as a named, explicit choice rather than
 * an accident: it backs tests, and it backs a run with nowhere durable to write
 * (no workspace), where the alternative would be failing every turn.
 */
const layerSessionOwnershipStoreMemory: Layer.Layer<SessionOwnershipStore> =
  Layer.effect(
    SessionOwnershipStore,
    Effect.gen(function* () {
      const records = yield* Ref.make<
        ReadonlyMap<string, SessionOwnershipRecord>
      >(new Map());
      return SessionOwnershipStore.of({
        read: (sessionId) =>
          Ref.get(records).pipe(
            Effect.map((current) =>
              Option.fromUndefinedOr(current.get(sessionId))
            )
          ),
        remove: (sessionId) =>
          Ref.update(records, (current) => {
            const next = new Map(current);
            next.delete(sessionId);
            return next;
          }),
        write: (record) =>
          Ref.update(records, (current) =>
            new Map(current).set(record.sessionId, record)
          ),
      });
    })
  );

export {
  layerSessionOwnershipStoreMemory,
  SessionOwnershipPersistenceError,
  SessionOwnershipStore,
};
export type { SessionOwnershipStoreShape };
