import type { RuntimeAuditEvent as RuntimeAuditEventType } from "./audit-event.ts";
import type {
  InvokeRuntimeCommand as InvokeRuntimeCommandType,
  RuntimeCommand as RuntimeCommandType,
} from "./command-types.ts";
import type { RuntimeJournalEntry as RuntimeJournalEntryType } from "./journal-entry.ts";
import type {
  RuntimeAuditEventLevel as RuntimeAuditEventLevelType,
  RuntimeCommandTag as RuntimeCommandTagType,
  RuntimeStreamEventTag as RuntimeStreamEventTagType,
} from "./protocol-tags.ts";
import type { RuntimeSessionSnapshot as RuntimeSessionSnapshotType } from "./session-snapshot-types.ts";
import type { RuntimeStreamEvent as RuntimeStreamEventType } from "./stream-event-types.ts";

import { RuntimeAuditEventSchema as RuntimeAuditEventSchemaValue } from "./audit-event.ts";
import {
  decodeRuntimeCommand as decodeRuntimeCommandValue,
  InvokeRuntimeCommandSchema as InvokeRuntimeCommandSchemaValue,
  RuntimeCommandSchema as RuntimeCommandSchemaValue,
} from "./command.ts";
import {
  decodeRuntimeJournalEntry as decodeRuntimeJournalEntryValue,
  RuntimeJournalEntrySchema as RuntimeJournalEntrySchemaValue,
} from "./journal-entry.ts";
import {
  RuntimeAuditEventLevel as RuntimeAuditEventLevelValue,
  RuntimeCommandTag as RuntimeCommandTagValue,
  RuntimeStreamEventTag as RuntimeStreamEventTagValue,
} from "./protocol-tags.ts";
import { RuntimeSessionSnapshotSchema as RuntimeSessionSnapshotSchemaValue } from "./session-snapshot.ts";
import {
  AuditRuntimeStreamEventSchema as AuditRuntimeStreamEventSchemaValue,
  CanonicalRuntimeStreamEventSchema as CanonicalRuntimeStreamEventSchemaValue,
  decodeRuntimeStreamEvent as decodeRuntimeStreamEventValue,
  decodeRuntimeStreamEventSync as decodeRuntimeStreamEventSyncValue,
  RuntimeStreamEventSchema as RuntimeStreamEventSchemaValue,
} from "./stream-event.ts";

export const RuntimeCommandTag = RuntimeCommandTagValue;
export type RuntimeCommandTag = RuntimeCommandTagType;

export const RuntimeStreamEventTag = RuntimeStreamEventTagValue;
export type RuntimeStreamEventTag = RuntimeStreamEventTagType;

export const RuntimeAuditEventLevel = RuntimeAuditEventLevelValue;
export type RuntimeAuditEventLevel = RuntimeAuditEventLevelType;

export const RuntimeJournalEntrySchema = RuntimeJournalEntrySchemaValue;
export type RuntimeJournalEntry = RuntimeJournalEntryType;

export const RuntimeSessionSnapshotSchema = RuntimeSessionSnapshotSchemaValue;
export type RuntimeSessionSnapshot = RuntimeSessionSnapshotType;

export const InvokeRuntimeCommandSchema = InvokeRuntimeCommandSchemaValue;
export type InvokeRuntimeCommand = InvokeRuntimeCommandType;

export const RuntimeCommandSchema = RuntimeCommandSchemaValue;
export type RuntimeCommand = RuntimeCommandType;

export const RuntimeAuditEventSchema = RuntimeAuditEventSchemaValue;
export type RuntimeAuditEvent = RuntimeAuditEventType;

export const AuditRuntimeStreamEventSchema = AuditRuntimeStreamEventSchemaValue;

export const CanonicalRuntimeStreamEventSchema =
  CanonicalRuntimeStreamEventSchemaValue;

export const RuntimeStreamEventSchema = RuntimeStreamEventSchemaValue;
export type RuntimeStreamEvent = RuntimeStreamEventType;

export const decodeRuntimeCommand = decodeRuntimeCommandValue;
export const decodeRuntimeStreamEvent = decodeRuntimeStreamEventValue;
export const decodeRuntimeStreamEventSync = decodeRuntimeStreamEventSyncValue;
export const decodeRuntimeJournalEntry = decodeRuntimeJournalEntryValue;
