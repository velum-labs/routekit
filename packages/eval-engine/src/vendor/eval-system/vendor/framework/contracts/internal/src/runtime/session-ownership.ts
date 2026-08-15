import { Schema } from "effect";

import { HarnessName, SessionId } from "../ids.ts";
import { decodeJsonString } from "../json.ts";

/**
 * The setup state a `session/load` or `session/resume` rebuilds its request
 * from. It holds replayable configuration only: credentials, prompts, and
 * native payloads are excluded, because a record outlives the transcript it
 * belonged to and must never become a place secrets accumulate.
 *
 * RFC 0003 also names MCP server configuration here. `SelectedAdapterOptions`
 * carries none today, so there is nothing to snapshot; that field arrives with
 * the option rather than ahead of it.
 */
const SessionSetupSnapshotSchema = Schema.Struct({
  /**
   * Capability-gated replacement state, not an incremental merge with whatever
   * directories a rebuilt process happens to hold.
   */
  additionalDirectories: Schema.Array(Schema.String),
  cwd: Schema.String,
}).annotate({ identifier: "SessionSetupSnapshot" });

/**
 * One durable mapping from an RouteKitEval session to the selected ACP agent session
 * that owns it, persisted outside the per-run log sidecar so ownership outlives
 * log retention: a session stays resumable after its transcript ages out.
 *
 * `adapterState` is opaque to the coordinator. The owning adapter produces it at
 * creation and consumes it at load; the coordinator never decodes it, branches
 * on it, or surfaces it in runtime events, which is what keeps provider-native
 * identity private to the adapter.
 */
const SessionOwnershipRecordSchema = Schema.Struct({
  adapterState: Schema.optionalKey(Schema.String),
  agent: HarnessName,
  createdAt: Schema.String,
  sessionId: SessionId,
  setup: SessionSetupSnapshotSchema,
  updatedAt: Schema.String,
}).annotate({ identifier: "SessionOwnershipRecord" });

type SessionOwnershipRecord = typeof SessionOwnershipRecordSchema.Type;
type SessionSetupSnapshot = typeof SessionSetupSnapshotSchema.Type;

const decodeSessionOwnershipRecord = decodeJsonString(
  SessionOwnershipRecordSchema
);

export {
  decodeSessionOwnershipRecord,
  SessionOwnershipRecordSchema,
  SessionSetupSnapshotSchema,
};
export type { SessionOwnershipRecord, SessionSetupSnapshot };
