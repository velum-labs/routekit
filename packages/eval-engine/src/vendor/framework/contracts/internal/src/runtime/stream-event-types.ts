import type { AgentRuntimeEvent } from "./agent-runtime-event-types.ts";
import type { RuntimeAuditEvent } from "./audit-event.ts";

export interface AuditRuntimeStreamEvent {
  readonly audit: RuntimeAuditEvent;
  readonly type: "audit.event";
}

export interface CanonicalRuntimeStreamEvent {
  readonly event: AgentRuntimeEvent;
  readonly type: "runtime.event";
}

export type RuntimeStreamEvent =
  | AuditRuntimeStreamEvent
  | CanonicalRuntimeStreamEvent;
