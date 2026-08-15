import type { Effect } from "effect";

import { Ref } from "effect";

import type { SessionId } from "../../../contracts/internal/src/ids.ts";
import type {
  InteractionState,
  PendingInteraction,
} from "./state.ts";

/** Atomically remove every pending interaction for one session and return them. */
export const takeSession = (
  state: Ref.Ref<InteractionState>,
  sessionId: SessionId
): Effect.Effect<readonly PendingInteraction[]> =>
  Ref.modify(state, (current) => {
    const taken: PendingInteraction[] = [];
    const pending = new Map(current.pending);
    for (const entry of current.pending.values()) {
      if (entry.identity.sessionId === sessionId) {
        taken.push(entry);
        pending.delete(entry.correlationId);
      }
    }
    return [
      taken,
      {
        ...current,
        pending,
      },
    ] as const;
  });

/** Atomically drain every pending interaction (peer exit / shutdown). */
export const takeAll = (
  state: Ref.Ref<InteractionState>
): Effect.Effect<readonly PendingInteraction[]> =>
  Ref.modify(
    state,
    (current) =>
      [
        [...current.pending.values()],
        {
          ...current,
          pending: new Map(),
        },
      ] as const
  );
