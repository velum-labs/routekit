import { Schema } from "effect";

export const RuntimeCommandId = Schema.String.pipe(
  Schema.brand("RuntimeCommandId")
);
export type RuntimeCommandId = typeof RuntimeCommandId.Type;

export const RuntimeAuditId = Schema.String.pipe(
  Schema.brand("RuntimeAuditId")
);
export type RuntimeAuditId = typeof RuntimeAuditId.Type;

export const RuntimeEventId = Schema.String.pipe(
  Schema.brand("RuntimeEventId")
);
export type RuntimeEventId = typeof RuntimeEventId.Type;

export const RuntimeJournalEntryId = Schema.String.pipe(
  Schema.brand("RuntimeJournalEntryId")
);
export type RuntimeJournalEntryId = typeof RuntimeJournalEntryId.Type;

export const HarnessName = Schema.String.pipe(Schema.brand("HarnessName"));
export type HarnessName = typeof HarnessName.Type;

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const RunId = Schema.String.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

export const TurnId = Schema.String.pipe(Schema.brand("TurnId"));
export type TurnId = typeof TurnId.Type;
