import { Schema } from "effect";

import type { RuntimeStreamEventTag as RuntimeStreamEventTagType } from "./protocol-tags.ts";
import type {
  AuditRuntimeStreamEvent,
  CanonicalRuntimeStreamEvent,
  RuntimeStreamEvent as RuntimeStreamEventType,
} from "./stream-event-types.ts";
import type { AssertAssignable } from "../type-boundary.ts";

import { AgentRuntimeEventSchema } from "./agent-runtime-event.ts";
import { RuntimeAuditEventSchema } from "./audit-event.ts";
import { RuntimeStreamEventTag as RuntimeStreamEventTagValue } from "./protocol-tags.ts";

const RuntimeStreamEventTag = RuntimeStreamEventTagValue;
type RuntimeStreamEventTag = RuntimeStreamEventTagType;

const AuditRuntimeStreamEventSchema = Schema.Struct({
  audit: RuntimeAuditEventSchema,
  type: Schema.Literal(RuntimeStreamEventTag.AuditEvent),
});

const CanonicalRuntimeStreamEventSchema = Schema.Struct({
  event: AgentRuntimeEventSchema,
  type: Schema.Literal(RuntimeStreamEventTag.RuntimeEvent),
});

const RuntimeStreamEventSchema = Schema.Union([
  AuditRuntimeStreamEventSchema,
  CanonicalRuntimeStreamEventSchema,
]).pipe(Schema.toTaggedUnion("type"));

type RuntimeStreamEvent = RuntimeStreamEventType;

type _AuditRuntimeStreamEventSchemaEncodesContract = AssertAssignable<
  typeof AuditRuntimeStreamEventSchema.Type,
  AuditRuntimeStreamEvent
>;
type _CanonicalRuntimeStreamEventSchemaEncodesContract = AssertAssignable<
  typeof CanonicalRuntimeStreamEventSchema.Type,
  CanonicalRuntimeStreamEvent
>;
type _RuntimeStreamEventSchemaEncodesContract = AssertAssignable<
  typeof RuntimeStreamEventSchema.Type,
  RuntimeStreamEvent
>;

export const decodeRuntimeStreamEvent = Schema.decodeUnknownEffect(
  RuntimeStreamEventSchema
);

export const decodeRuntimeStreamEventSync = Schema.decodeUnknownSync(
  RuntimeStreamEventSchema
);

export {
  RuntimeStreamEventTag,
  AuditRuntimeStreamEventSchema,
  CanonicalRuntimeStreamEventSchema,
  RuntimeStreamEventSchema,
};
export type { RuntimeStreamEvent };
