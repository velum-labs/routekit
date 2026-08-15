import type { Deferred } from "effect";

import { Effect, Ref } from "effect";

import type {
  ElicitationResolvedAction,
  PermissionOptionKind,
} from "../../../contracts/author/src/agent-event.ts";
import type { SessionId } from "../../../contracts/internal/src/ids.ts";
import type {
  ElicitationAcceptedContent,
  ElicitationContentValidator,
  InteractionConfig,
  InteractionIdentity,
  InteractionKind,
  InteractionResponse,
  InteractionTerminal,
  PermissionOffer,
  PermissionResponse,
  RegisterInput,
} from "./model.ts";

import { InteractionCapacityError } from "./errors.ts";
import { InteractionCorrelationId } from "./model.ts";

/**
 * One live pending interaction. `offeredOptionIds` is populated for permission
 * requests so a submitted `optionId` can be validated against exactly what was
 * offered; it is empty for elicitation. `deferred` is completed with the
 * terminal outcome exactly once, waking whoever awaits the handle.
 */
export interface PendingInteraction {
  readonly correlationId: InteractionCorrelationId;
  readonly deferred: Deferred.Deferred<InteractionTerminal>;
  readonly identity: InteractionIdentity;
  readonly kind: InteractionKind;
  readonly offeredOptionIds: ReadonlySet<string>;
  readonly permissionOffers: readonly PermissionOffer[];
  /**
   * Present only for an elicitation registered with a form validator. The
   * accept path runs it against submitted content before settling; a permission
   * or a schema-less elicitation leaves it `undefined`.
   */
  readonly validateAccepted?: ElicitationContentValidator | undefined;
}

/**
 * The whole service's ephemeral state. `nextSeq` mints monotonic correlation
 * ids; because ids are never reused, an id whose sequence is below `nextSeq`
 * but absent from `pending` must already have reached a terminal state — that
 * is how a stale/duplicate response is told apart from an id that never
 * existed, without an unbounded tombstone set.
 */
export interface InteractionState {
  readonly nextSeq: number;
  readonly pending: ReadonlyMap<InteractionCorrelationId, PendingInteraction>;
}

export const initialState: InteractionState = {
  nextSeq: 0,
  pending: new Map(),
};

const CORRELATION_PREFIX = "ixn-";

const correlationIdOf = (seq: number): InteractionCorrelationId =>
  InteractionCorrelationId.make(`${CORRELATION_PREFIX}${seq}`);

const seqOf = (id: InteractionCorrelationId): number | null => {
  if (!id.startsWith(CORRELATION_PREFIX)) {
    return null;
  }
  const seq = Number(id.slice(CORRELATION_PREFIX.length));
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
};

export type RegisterReservation =
  | {
      readonly correlationId: InteractionCorrelationId;
      readonly type: "reserved";
    }
  | { readonly error: InteractionCapacityError; readonly type: "capacity" };

const countForSession = (
  pending: InteractionState["pending"],
  sessionId: SessionId
): number => {
  let count = 0;
  for (const entry of pending.values()) {
    if (entry.identity.sessionId === sessionId) {
      count += 1;
    }
  }
  return count;
};

export interface ReserveOptions {
  readonly config: InteractionConfig;
  readonly deferred: Deferred.Deferred<InteractionTerminal>;
  readonly input: RegisterInput;
  readonly state: Ref.Ref<InteractionState>;
}

const makePending = (
  correlationId: InteractionCorrelationId,
  deferred: Deferred.Deferred<InteractionTerminal>,
  input: RegisterInput
): PendingInteraction => ({
  correlationId,
  deferred,
  identity: {
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    turnId: input.turnId,
  },
  kind: input.kind,
  offeredOptionIds:
    input.kind === "permission"
      ? new Set(input.options.map((option) => option.optionId))
      : new Set<string>(),
  permissionOffers: input.kind === "permission" ? input.options : [],
  validateAccepted:
    input.kind === "elicitation" ? input.validateAccepted : undefined,
});

export const reserve = ({
  config,
  deferred,
  input,
  state,
}: ReserveOptions): Effect.Effect<RegisterReservation> =>
  Ref.modify<InteractionState, RegisterReservation>(state, (current) => {
    if (current.pending.size >= config.maxPendingTotal) {
      return [
        {
          error: new InteractionCapacityError({
            capacity: config.maxPendingTotal,
            scope: "total",
          }),
          type: "capacity",
        },
        current,
      ] as const;
    }
    if (
      countForSession(current.pending, input.sessionId) >=
      config.maxPendingPerSession
    ) {
      return [
        {
          error: new InteractionCapacityError({
            capacity: config.maxPendingPerSession,
            scope: "session",
            sessionId: input.sessionId,
          }),
          type: "capacity",
        },
        current,
      ] as const;
    }
    const correlationId = correlationIdOf(current.nextSeq);
    const pending = new Map([
      ...current.pending,
      [correlationId, makePending(correlationId, deferred, input)] as const,
    ]);
    return [
      {
        correlationId,
        type: "reserved",
      },
      {
        nextSeq: current.nextSeq + 1,
        pending,
      },
    ] as const;
  });

const withoutPending = (
  current: InteractionState,
  correlationId: InteractionCorrelationId
): InteractionState => {
  const pending = new Map(current.pending);
  pending.delete(correlationId);
  return {
    ...current,
    pending,
  };
};

/** Classify an absent correlationId: below `nextSeq` means it already settled. */
const classifyAbsent = (
  current: InteractionState,
  correlationId: InteractionCorrelationId
): "already-terminal" | "unknown" => {
  const seq = seqOf(correlationId);
  return seq !== null && seq < current.nextSeq ? "already-terminal" : "unknown";
};

export type TakeResult =
  | { readonly pending: PendingInteraction; readonly type: "taken" }
  | {
      readonly reason: "already-terminal" | "unknown";
      readonly type: "not-pending";
    };

/** Atomically remove and return one pending interaction, or classify its absence. */
export const takeOne = (
  state: Ref.Ref<InteractionState>,
  correlationId: InteractionCorrelationId
): Effect.Effect<TakeResult> =>
  Ref.modify<InteractionState, TakeResult>(state, (current) => {
    const pending = current.pending.get(correlationId);
    if (pending === undefined) {
      return [
        {
          reason: classifyAbsent(current, correlationId),
          type: "not-pending",
        },
        current,
      ] as const;
    }
    return [
      {
        pending,
        type: "taken",
      },
      withoutPending(current, correlationId),
    ] as const;
  });

export type RespondResult =
  | {
      readonly pending: PendingInteraction;
      readonly response: InteractionResponse;
      readonly type: "resolved";
    }
  | { readonly detail: string; readonly type: "invalid" }
  | {
      readonly reason: "already-terminal" | "unknown";
      readonly type: "not-pending";
    };

const validatePermission = (
  pending: PendingInteraction,
  response: PermissionResponse
): RespondResult => {
  if (pending.kind !== "permission") {
    return {
      detail: "permission response submitted to an elicitation request",
      type: "invalid",
    };
  }
  if (
    response.outcome === "selected" &&
    !pending.offeredOptionIds.has(response.optionId)
  ) {
    return {
      detail: `optionId "${response.optionId}" was not offered`,
      type: "invalid",
    };
  }
  return {
    pending,
    response:
      response.outcome === "selected"
        ? {
            kind: "permission",
            optionId: response.optionId,
            outcome: "selected",
          }
        : {
            kind: "permission",
            outcome: "cancelled",
          },
    type: "resolved",
  };
};

/** A surface-submitted elicitation action plus the content an accept carries. */
export interface ElicitationSubmission {
  readonly action: ElicitationResolvedAction;
  readonly content?: ElicitationAcceptedContent | undefined;
}

const elicitationResponse = ({
  action,
  content,
}: ElicitationSubmission): Extract<
  InteractionResponse,
  { readonly kind: "elicitation" }
> => {
  if (action !== "accept") {
    return {
      action,
      kind: "elicitation",
    };
  }
  // Only attach `content` when there is some, so a fieldless accept keeps the
  // bare `{ action, kind }` shape.
  return content === undefined
    ? {
        action: "accept",
        kind: "elicitation",
      }
    : {
        action: "accept",
        content,
        kind: "elicitation",
      };
};

const validateElicitation = (
  pending: PendingInteraction,
  submission: ElicitationSubmission
): RespondResult =>
  pending.kind === "elicitation"
    ? {
        pending,
        response: elicitationResponse(submission),
        type: "resolved",
      }
    : {
        detail: "elicitation response submitted to a permission request",
        type: "invalid",
      };

const applyRespond = (
  state: Ref.Ref<InteractionState>,
  correlationId: InteractionCorrelationId,
  validate: (pending: PendingInteraction) => RespondResult
): Effect.Effect<RespondResult> =>
  Ref.modify<InteractionState, RespondResult>(state, (current) => {
    const pending = current.pending.get(correlationId);
    if (pending === undefined) {
      return [
        {
          reason: classifyAbsent(current, correlationId),
          type: "not-pending",
        },
        current,
      ] as const;
    }
    const result = validate(pending);
    // An invalid or mismatched response leaves the request pending so a correct
    // response can still settle it; only a valid response removes the entry.
    return result.type === "resolved"
      ? ([result, withoutPending(current, correlationId)] as const)
      : ([result, current] as const);
  });

export const resolvePermission = (
  state: Ref.Ref<InteractionState>,
  correlationId: InteractionCorrelationId,
  response: PermissionResponse
): Effect.Effect<RespondResult> =>
  applyRespond(state, correlationId, (pending) =>
    validatePermission(pending, response)
  );

export const resolvePermissionKind = (
  state: Ref.Ref<InteractionState>,
  correlationId: InteractionCorrelationId,
  kind: PermissionOptionKind
): Effect.Effect<RespondResult> =>
  applyRespond(state, correlationId, (pending) => {
    if (pending.kind !== "permission") {
      return validatePermission(pending, { outcome: "cancelled" });
    }
    const matching = pending.permissionOffers.filter(
      (offer) => offer.kind === kind
    );
    return matching.length === 1 && matching[0] !== undefined
      ? validatePermission(pending, {
          optionId: matching[0].optionId,
          outcome: "selected",
        })
      : {
          detail: `permission option kind "${kind}" was not offered exactly once`,
          type: "invalid",
        };
  });

export const resolveElicitation = (
  state: Ref.Ref<InteractionState>,
  correlationId: InteractionCorrelationId,
  submission: ElicitationSubmission
): Effect.Effect<RespondResult> =>
  applyRespond(state, correlationId, (pending) =>
    validateElicitation(pending, submission)
  );

/**
 * Read the accept-content validator for a pending elicitation without removing
 * it, so the service can validate submitted content before the atomic settle.
 * Returns `undefined` when the correlationId is absent or is not an elicitation
 * carrying a validator.
 */
export const peekAcceptValidator = (
  state: Ref.Ref<InteractionState>,
  correlationId: InteractionCorrelationId
): Effect.Effect<ElicitationContentValidator | undefined> =>
  Ref.get(state).pipe(
    Effect.map(
      (current) => current.pending.get(correlationId)?.validateAccepted
    )
  );
