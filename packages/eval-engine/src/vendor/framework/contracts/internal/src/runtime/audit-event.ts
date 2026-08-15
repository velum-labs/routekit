import { Schema } from "effect";

import type { RuntimeAuditEventLevel as RuntimeAuditEventLevelType } from "./protocol-tags.ts";

import { RuntimeAuditId, RuntimeCommandId } from "../ids.ts";
import { RuntimeAuditEventLevel as RuntimeAuditEventLevelValue } from "./protocol-tags.ts";

const RuntimeAuditEventLevel = RuntimeAuditEventLevelValue;
type RuntimeAuditEventLevel = RuntimeAuditEventLevelType;

/**
 * The single source of truth for a runtime audit event: {@link RuntimeAuditEvent}
 * is derived from this struct, so a field added or dropped here reaches every
 * consumer instead of drifting from a hand-written twin.
 *
 * `commandId` and `detail` are `optionalKey`, which under
 * `exactOptionalPropertyTypes` means absent rather than present-and-undefined.
 * Producers must omit the key, not set it to `undefined`.
 */
const RuntimeAuditEventSchema = Schema.Struct({
  auditId: RuntimeAuditId,
  commandId: Schema.optionalKey(RuntimeCommandId),
  createdAt: Schema.String,
  detail: Schema.optionalKey(Schema.Unknown),
  level: Schema.Literals([
    RuntimeAuditEventLevel.Debug,
    RuntimeAuditEventLevel.Error,
    RuntimeAuditEventLevel.Info,
    RuntimeAuditEventLevel.Warn,
  ]),
  message: Schema.String,
  name: Schema.String,
});

type RuntimeAuditEvent = typeof RuntimeAuditEventSchema.Type;

/**
 * The rendered audit-line prefix and the appended-event audit name are a
 * cross-process string contract: the daemon renders
 * `[ori-runtime] <ts> <LEVEL> <name> …` lines and the CLI's dev-log tee
 * pattern-matches them to drop the per-event narration (each runtime event is
 * already persisted structurally). Both sides import these constants so a
 * rename cannot silently break the dedup and double-log every event.
 */
const RUNTIME_AUDIT_LINE_PREFIX = "[ori-runtime]";
const RUNTIME_EVENT_APPENDED_AUDIT_NAME = "runtime.event.appended";

export {
  RUNTIME_AUDIT_LINE_PREFIX,
  RUNTIME_EVENT_APPENDED_AUDIT_NAME,
  RuntimeAuditEventLevel,
  RuntimeAuditEventSchema,
};
export type { RuntimeAuditEvent };
