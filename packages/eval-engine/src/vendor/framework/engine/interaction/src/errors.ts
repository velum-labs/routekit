import { Data } from "effect";

import type { InteractionCorrelationId } from "./model.ts";

/**
 * Registration exceeded a pending bound. `scope` says whether the whole
 * connection budget (`total`) or the owning session budget (`session`) was
 * full; `sessionId` is present only for the `session` scope.
 */
export class InteractionCapacityError extends Data.TaggedError(
  "InteractionCapacityError"
)<{
  readonly capacity: number;
  readonly scope: "session" | "total";
  readonly sessionId?: string;
}> {}

/**
 * A response, cancellation, or failure targeted a correlationId the service is
 * not currently holding. `reason` distinguishes an id that was never issued
 * (`unknown`) from one that already reached a terminal state (`already-terminal`)
 * — the latter is how a duplicate or stale second response is refused, so a
 * response can never win twice.
 */
export class InteractionNotPendingError extends Data.TaggedError(
  "InteractionNotPendingError"
)<{
  readonly correlationId: InteractionCorrelationId;
  readonly reason: "already-terminal" | "unknown";
}> {}

/**
 * A response did not match its registered request: a permission response sent
 * to an elicitation (or vice versa), or a selected `optionId` that was never
 * offered. The interaction stays pending so a correct response can still
 * settle it. `detail` is a bounded, safe description for diagnostics.
 */
export class InteractionInvalidResponseError extends Data.TaggedError(
  "InteractionInvalidResponseError"
)<{
  readonly correlationId: InteractionCorrelationId;
  readonly detail: string;
}> {}

export type InteractionError =
  | InteractionCapacityError
  | InteractionInvalidResponseError
  | InteractionNotPendingError;
