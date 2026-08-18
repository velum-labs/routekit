import type { ValueOf } from "../../../../utils/core/src/types.ts";

export const RuntimeCommandTag = {
  InvokeAgent: "agent.invoke",
} as const;

export type RuntimeCommandTag = ValueOf<typeof RuntimeCommandTag>;

export const RuntimeStreamEventTag = {
  AuditEvent: "audit.event",
  RuntimeEvent: "runtime.event",
} as const;

export type RuntimeStreamEventTag = ValueOf<typeof RuntimeStreamEventTag>;

export const RuntimeAuditEventLevel = {
  Debug: "debug",
  Error: "error",
  Info: "info",
  Warn: "warn",
} as const;

export type RuntimeAuditEventLevel = ValueOf<typeof RuntimeAuditEventLevel>;
