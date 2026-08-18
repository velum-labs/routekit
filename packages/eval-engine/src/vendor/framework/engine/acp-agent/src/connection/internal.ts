import type { Deferred, Queue, Ref, Schema } from "effect";

import type { AcpPendingRequest } from "../../../../contracts/internal/src/acp/codec/codec.ts";
import type {
  AcpClientKnownRequest,
  AcpDecodedEnvelope,
  AcpRequestId,
} from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AcpAgentConnectionError } from "../errors.ts";
import type { AcpClientCapabilitiesSnapshot } from "../service.ts";
import type { AcpTransportShape } from "../../../acp-client/src/transport.ts";

export type AcpDecodedResponseEnvelope = Extract<
  AcpDecodedEnvelope,
  { readonly kind: "errorResponseEnvelope" | "successResponseEnvelope" }
>;

export interface ConnectionConfig {
  readonly cancellationRetention: number;
  readonly inboundConcurrency: number;
  readonly inboundRequestCapacity: number;
  readonly outboundCapacity: number;
  readonly pendingRequestCapacity: number;
}

export interface PendingRequest {
  readonly context: AcpPendingRequest<"agentToClient">;
  readonly deferred: Deferred.Deferred<unknown, AcpAgentConnectionError>;
}

interface ActiveInbound {
  readonly cancel: Deferred.Deferred<true>;
}

export interface InboundWork {
  readonly cancel: Deferred.Deferred<true>;
  readonly request: AcpClientKnownRequest;
}

export interface OutboundItem {
  readonly acknowledgement?: Deferred.Deferred<true, AcpAgentConnectionError>;
  readonly message: Schema.Json;
}

export interface ConnectionState {
  readonly active: ReadonlyMap<AcpRequestId, ActiveInbound>;
  readonly cancelled: ReadonlySet<number>;
  readonly capabilities?: AcpClientCapabilitiesSnapshot;
  readonly closed?: AcpAgentConnectionError;
  readonly initializing: boolean;
  readonly nextId: number;
  readonly outboundAcknowledgements: ReadonlySet<
    Deferred.Deferred<true, AcpAgentConnectionError>
  >;
  readonly pending: ReadonlyMap<number, PendingRequest>;
}

export interface ConnectionResources {
  readonly cancellationOutbound: Queue.Queue<OutboundItem>;
  readonly inboundRequests: Queue.Queue<InboundWork>;
  readonly outbound: Queue.Queue<OutboundItem>;
  readonly state: Ref.Ref<ConnectionState>;
  readonly stop: Deferred.Deferred<true>;
  readonly transport: AcpTransportShape;
}
