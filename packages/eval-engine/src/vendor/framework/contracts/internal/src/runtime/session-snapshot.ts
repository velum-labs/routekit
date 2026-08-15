import { Schema } from "effect";

import type { RuntimeSessionSnapshot as RuntimeSessionSnapshotType } from "./session-snapshot-types.ts";
import type { AssertAssignable } from "../type-boundary.ts";

import {
  HarnessName,
  RunId,
  SessionId,
  TurnId,
} from "../ids.ts";
import { decodeJsonString } from "../json.ts";
import { PendingRolloverReasonSchema } from "./session-snapshot-types.ts";

const RuntimeSessionSnapshotSchema = Schema.Struct({
  completedTurns: Schema.Number,
  failedTurns: Schema.Number,
  firstSeenAt: Schema.String,
  harness: HarnessName,
  lastContextTokens: Schema.optionalKey(Schema.Number),
  lastEventType: Schema.String,
  lastUsageModel: Schema.optionalKey(Schema.String),
  parentSessionId: Schema.optionalKey(SessionId),
  pendingRollover: Schema.optionalKey(PendingRolloverReasonSchema),
  runIds: Schema.Array(RunId),
  sessionId: SessionId,
  turnIds: Schema.Array(TurnId),
  updatedAt: Schema.String,
});

type RuntimeSessionSnapshot = RuntimeSessionSnapshotType;

type _RuntimeSessionSnapshotSchemaEncodesContract = AssertAssignable<
  typeof RuntimeSessionSnapshotSchema.Type,
  RuntimeSessionSnapshot
>;

/** Body of `GET /api/sessions`: the daemon's in-memory session snapshots. */
export const RuntimeSessionsResponseSchema = Schema.Struct({
  sessions: Schema.Array(RuntimeSessionSnapshotSchema),
});

export const decodeRuntimeSessionsResponse = decodeJsonString(
  RuntimeSessionsResponseSchema
);

export { RuntimeSessionSnapshotSchema };
export type { RuntimeSessionSnapshot };
