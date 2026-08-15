import type { Schema } from "effect";

import type { AcpSuccessResponseEnvelope } from "../protocol/profile.ts";

import { AcpMessageKind } from "../protocol/message-kinds.ts";

type KnownRequest<T> = T & {
  readonly kind: typeof AcpMessageKind.Request;
  readonly supported: true;
};
type KnownNotification<T> = T & {
  readonly kind: typeof AcpMessageKind.Notification;
  readonly supported: true;
};
interface KnownCorrelatedResult {
  readonly method: string;
  readonly result: Schema.Json;
}
type KnownSuccessResponse<T extends KnownCorrelatedResult> = Omit<
  AcpSuccessResponseEnvelope,
  "error" | "method" | "result"
> &
  T & {
    readonly kind: typeof AcpMessageKind.SuccessResponse;
  };

const makeKnownRequest = <T>(value: T): KnownRequest<T> => ({
  ...value,
  kind: AcpMessageKind.Request,
  supported: true,
});

const makeKnownNotification = <T>(value: T): KnownNotification<T> => ({
  ...value,
  kind: AcpMessageKind.Notification,
  supported: true,
});

const makeKnownSuccessResponse = <T extends KnownCorrelatedResult>(
  value: T,
  envelope: AcpSuccessResponseEnvelope
): KnownSuccessResponse<T> => ({
  ...envelope,
  ...value,
  kind: AcpMessageKind.SuccessResponse,
});

export type { KnownNotification, KnownRequest, KnownSuccessResponse };
export { makeKnownNotification, makeKnownRequest, makeKnownSuccessResponse };
