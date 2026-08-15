import type { Duration, Effect } from "effect";

import { Schema } from "effect";

import type {
  ElicitationFieldSummary,
  PermissionOptionKind,
} from "../../../contracts/author/src/agent-event.ts";
import type { SessionId, TurnId } from "../../../contracts/internal/src/ids.ts";

type ValueOf<T> = T[keyof T];

/**
 * The runtime-interaction service's own correlation handle for one pending
 * agent-to-client request. It is minted by the service, independent of the ACP
 * JSON-RPC request id the connection owns: the S3 bridge holds the association
 * between this id and the wire id, so the two ownership paths never leak into
 * each other (RFC 0003 Interactive Request Lifecycle, "Request ownership").
 */
export const InteractionCorrelationId = Schema.String.pipe(
  Schema.brand("InteractionCorrelationId")
);
export type InteractionCorrelationId = typeof InteractionCorrelationId.Type;

/** The two interactive-request domains that share these lifecycle mechanics. */
export type InteractionKind = "elicitation" | "permission";

/**
 * Session and turn lineage the service correlates a pending interaction by. A
 * `sessionId` is always known; `turnId`/`toolCallId` narrow the interaction to
 * the work that raised it when the caller has them.
 */
export interface InteractionIdentity {
  readonly sessionId: SessionId;
  readonly toolCallId?: string | undefined;
  readonly turnId?: TurnId | undefined;
}

/**
 * One option an ACP `session/request_permission` offered. The service keeps the
 * full `{ optionId, kind }` pair to validate a submitted `optionId` against
 * what was offered, while the journaled `permission.requested` event carries
 * only the safe {@link PermissionOptionKind} vocabulary.
 */
export interface PermissionOffer {
  readonly kind: PermissionOptionKind;
  readonly optionId: string;
}

export interface PermissionRegisterInput extends InteractionIdentity {
  readonly kind: "permission";
  readonly operation: string;
  readonly options: readonly PermissionOffer[];
}

export interface ElicitationRegisterInput extends InteractionIdentity {
  readonly fields: readonly ElicitationFieldSummary[];
  readonly kind: "elicitation";
  readonly message: string;
  readonly requestId?: string | undefined;
  /**
   * Validates surface-submitted accepted content against the originating
   * request's `requestedSchema` before the accept settles. Supplied by the S3
   * bridge at register time so the lifecycle engine never holds the ACP wire
   * schema itself: it only invokes this closure and translates a rejection into
   * an {@link InteractionInvalidResponseError}. Absent when a request carries no
   * form fields (an empty schema) — then accept content is passed through
   * unchanged.
   */
  readonly validateAccepted?: ElicitationContentValidator | undefined;
}

export type RegisterInput = ElicitationRegisterInput | PermissionRegisterInput;

/**
 * A single validated form value in the restricted ACP elicitation vocabulary
 * (string / number / integer / boolean / string-array). `integer` and `number`
 * both surface as `number`.
 */
export type ElicitationContentValue =
  | boolean
  | number
  | string
  | readonly string[];

/**
 * Accepted form content, keyed by field name. Carried transiently on the
 * `responded` terminal so the S3 bridge can return it in the ACP
 * `elicitation/create` accept result. It is deliberately NOT part of the emitted
 * `elicitation.resolved` runtime event or the durable journal (RFC 0003
 * Interactive Request Lifecycle, "Persistence and replay").
 */
export type ElicitationAcceptedContent = Readonly<
  Record<string, ElicitationContentValue>
>;

/** A bounded, journal-safe reason submitted content failed schema validation. */
export interface ElicitationContentRejection {
  readonly detail: string;
}

/**
 * Validates and normalizes surface-submitted accepted content. Succeeds with
 * the content to carry on the terminal, or fails with a bounded rejection the
 * service turns into an {@link InteractionInvalidResponseError} (leaving the
 * request pending so a corrected response can still settle it).
 */
export type ElicitationContentValidator = (
  content: ElicitationAcceptedContent
) => Effect.Effect<ElicitationAcceptedContent, ElicitationContentRejection>;

/** The domain response a surface submits for a permission prompt. */
export type PermissionResponse =
  | { readonly optionId: string; readonly outcome: "selected" }
  | { readonly outcome: "cancelled" };

/**
 * The domain response a surface submits for a form elicitation. Only `accept`
 * carries content; `decline` and `cancel` never do (RFC 0003). The content is
 * validated against the request's `requestedSchema` before the accept settles.
 */
export type ElicitationResponse =
  | {
      readonly action: "accept";
      readonly content?: ElicitationAcceptedContent | undefined;
    }
  | { readonly action: "cancel" }
  | { readonly action: "decline" };

/**
 * The single terminal state every pending interaction reaches exactly once
 * (RFC 0003 Interactive Request Lifecycle, "Request ownership"). The awaited
 * handle resolves with this value; the S3 bridge maps it to the concrete ACP
 * response (a `session/request_permission` result, an `elicitation/create`
 * result, or a JSON-RPC error). None of these are Effect failures of the await
 * itself — they are all legitimate settlements the bridge must translate.
 */
export type InteractionTerminal =
  | { readonly response: InteractionResponse; readonly state: "responded" }
  | { readonly state: "cancelled-by-request" }
  | { readonly state: "cancelled-by-session" }
  | { readonly state: "failed-invalid" }
  | { readonly state: "failed-peer-exit" }
  | { readonly state: "failed-surface-disconnect" };

/**
 * The validated domain response carried by a `responded` terminal. The
 * elicitation `accept` variant carries the validated {@link
 * ElicitationAcceptedContent} so the S3 bridge can return it in the ACP accept
 * result; the emitted `elicitation.resolved` event projects only the action and
 * never this content.
 */
export type InteractionResponse =
  | {
      readonly kind: "permission";
      readonly optionId: string;
      readonly outcome: "selected";
    }
  | { readonly kind: "permission"; readonly outcome: "cancelled" }
  | {
      readonly action: "accept";
      readonly content?: ElicitationAcceptedContent | undefined;
      readonly kind: "elicitation";
    }
  | { readonly action: "cancel"; readonly kind: "elicitation" }
  | { readonly action: "decline"; readonly kind: "elicitation" };

/** The three failure terminals a per-request or fail-all cleanup can settle. */
export const InteractionFailureState = {
  Invalid: "failed-invalid",
  PeerExit: "failed-peer-exit",
  SurfaceDisconnect: "failed-surface-disconnect",
} as const;
export type InteractionFailureState = ValueOf<typeof InteractionFailureState>;

/**
 * Handle returned by `register`. The caller (the S3 bridge) awaits
 * {@link InteractionHandle.awaitOutcome} for the terminal settlement, then
 * writes the matching ACP response. Awaiting is interruptible; a fail-all or
 * cancellation wakes it with the corresponding {@link InteractionTerminal}.
 */
export interface InteractionHandle {
  readonly awaitOutcome: Effect.Effect<InteractionTerminal>;
  readonly correlationId: InteractionCorrelationId;
}

/**
 * Admission bounds. `maxPendingTotal` guards the whole connection; each session
 * is separately capped by `maxPendingPerSession` so one session cannot exhaust
 * the shared budget (RFC 0003: "Pending requests are bounded per connection and
 * per session").
 *
 * `pendingTimeout` optionally bounds how long any one request may stay pending.
 * Admission caps alone bound the *count* of waiters, not their lifetime: a
 * surface that receives a request and then goes away without responding leaves
 * its slot held for as long as the connection lives.
 *
 * `undefined` means unbounded, and that is the default, because a pending
 * request is usually a human being asked a question. An interactive user who
 * steps away from a permission prompt over lunch must come back to it still
 * waiting, not silently denied. Only a surface that knows its waiter is not a
 * person at a terminal should set this.
 */
export interface InteractionConfig {
  readonly maxPendingPerSession: number;
  readonly maxPendingTotal: number;
  readonly pendingTimeout?: Duration.Duration | undefined;
}

export const defaultInteractionConfig: InteractionConfig = {
  maxPendingPerSession: 16,
  maxPendingTotal: 256,
};
