import type { Deferred, Effect, Option, Queue, Ref, Schema } from "effect";

import type {
  AcpDecodedAgentPeerMessage,
  AcpPendingRequest,
} from "../../../../contracts/internal/src/acp/codec/codec.ts";
import type {
  AcpAgentKnownNotification,
  AcpRequestId,
} from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AcpConnectionError } from "../errors.ts";
import type { AcpCapabilitySnapshot } from "../service.ts";
import type { AcpTransportShape } from "../transport.ts";

export type Terminate = (error: AcpConnectionError) => Effect.Effect<void>;
export type Enqueue = (
  message: Schema.Json
) => Effect.Effect<void, AcpConnectionError>;
export type OfferCancellation = (
  message: Schema.Json
) => Effect.Effect<void, AcpConnectionError>;

export interface ConnectionConfig {
  readonly cancellationRetention: number;
  readonly inboundConcurrency: number;
  readonly inboundRequestCapacity: number;
  readonly notificationCapacity: number;
  readonly outboundCapacity: number;
  readonly pendingRequestCapacity: number;
}

export interface PendingRequest {
  readonly context: AcpPendingRequest;
  readonly deferred: Deferred.Deferred<unknown, AcpConnectionError>;
}

export interface OutboundItem {
  readonly acknowledgement?: Deferred.Deferred<true, AcpConnectionError>;
  readonly message: Schema.Json;
}

export interface ConnectionState {
  readonly activeInbound: ReadonlyMap<AcpRequestId, Deferred.Deferred<true>>;
  readonly cancelled: ReadonlySet<number>;
  readonly closed: AcpConnectionError | undefined;
  readonly nextId: number;
  readonly outboundAcknowledgements: ReadonlySet<
    Deferred.Deferred<true, AcpConnectionError>
  >;
  readonly pending: ReadonlyMap<number, PendingRequest>;
}

export type InitializationState =
  | { readonly error: AcpConnectionError; readonly type: "closed" }
  | { readonly type: "fresh" }
  | { readonly type: "running" }
  | { readonly snapshot: AcpCapabilitySnapshot; readonly type: "ready" };

export type KnownInboundRequest = Extract<
  AcpDecodedAgentPeerMessage,
  { readonly kind: "request"; readonly supported: true }
>;

export interface InboundWork {
  readonly cancel: Deferred.Deferred<true>;
  readonly request: KnownInboundRequest;
}

export type ConnectionNotificationItem =
  | {
      readonly notification: AcpAgentKnownNotification;
      readonly type: "notification";
    }
  | {
      readonly token: object;
      readonly type: "barrier";
    };

/**
 * The lease held by the single active notification consumer. `ended` resolves
 * when the consumer's stream releases the lease, which unblocks an inbound
 * publish that is waiting on notification capacity: without it the sole reader
 * fiber would keep waiting for a consumer that no longer exists.
 */
export interface NotificationConsumerLease {
  readonly ended: Deferred.Deferred<true>;
}

export interface ConnectionResources {
  readonly closed: Deferred.Deferred<AcpConnectionError>;
  readonly inboundRequests: Queue.Queue<InboundWork>;
  readonly initialization: Ref.Ref<InitializationState>;
  readonly notificationConsumer: Ref.Ref<
    Option.Option<NotificationConsumerLease>
  >;
  readonly notifications: Queue.Queue<ConnectionNotificationItem>;
  readonly outbound: Queue.Queue<OutboundItem>;
  readonly state: Ref.Ref<ConnectionState>;
  readonly stop: Deferred.Deferred<true>;
  readonly transport: AcpTransportShape;
}
