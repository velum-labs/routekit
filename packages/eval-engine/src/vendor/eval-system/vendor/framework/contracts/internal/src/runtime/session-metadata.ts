import { Schema } from "effect";

import { HarnessName, RunId, SessionId } from "../ids.ts";
import { decodeJsonString } from "../json.ts";
import { RuntimeUsageSchema } from "./agent-runtime-event.ts";

/**
 * Per-run context for one of the runs a session spanned. Because a session can
 * span multiple runs under `--resume`, the sidecar keeps an array of these
 * rather than a single scalar `cwd`/`model`/`prompt` — a scalar would silently
 * lose the value from every run but the last. Each field is derived from that
 * run's `run.started` record (the only event that carries them); a field is
 * absent when the run's `run.started` did not carry it.
 */
const SessionRunMetadataSchema = Schema.Struct({
  cwd: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  model: Schema.optionalKey(Schema.UndefinedOr(Schema.NullOr(Schema.String))),
  prompt: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  runId: RunId,
  /**
   * The invoking user this run ran on behalf of (ROUTEKIT_EVAL-361), when the caller
   * supplied one on `agent.invoke`. Folded from that run's `run.started`
   * record, so per-run attribution survives across `--resume` (each run keeps
   * its own invoker) and is rebuildable from the run event log. Absent when the
   * run carried no invoking user.
   */
  userId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

/**
 * The durable, on-disk form of a session's shape, persisted to
 * `.routekit-eval/logs/sessions/<sessionId>/metadata.json`. It is a **projection** over
 * the authoritative per-run event log (never a second writer): every field is
 * folded from the run stream's `runtime.event` records, so the sidecar can be
 * rebuilt from the run files at any time and can never disagree with them.
 *
 * Mirrors the in-memory `RuntimeSessionSnapshot` shape (harness, turn counts,
 * `lastEventType`, timestamps) and adds the run-level context the events already
 * carry: `startedAt`/`endedAt`, terminal `usage`, and the per-run `runIds`
 * array.
 */
const SessionMetadataSchema = Schema.Struct({
  completedTurns: Schema.Number,
  endedAt: Schema.String,
  failedTurns: Schema.Number,
  harness: HarnessName,
  lastEventType: Schema.String,
  runIds: Schema.Array(SessionRunMetadataSchema),
  sessionId: SessionId,
  startedAt: Schema.String,
  usage: Schema.optionalKey(Schema.UndefinedOr(RuntimeUsageSchema)),
});

type SessionMetadata = typeof SessionMetadataSchema.Type;
type SessionRunMetadata = typeof SessionRunMetadataSchema.Type;

/** Body of `GET /api/sessions/:id`: one session's persisted sidecar metadata. */
export const decodeSessionMetadata = decodeJsonString(SessionMetadataSchema);

export { SessionMetadataSchema, SessionRunMetadataSchema };
export type { SessionMetadata, SessionRunMetadata };
