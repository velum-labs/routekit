import { Effect, FileSystem, Option, Path, Schema } from "effect";

import {
  decodeJsonString,
  encodeJsonString,
} from "../../../../contracts/internal/src/json.ts";
import { UpdateSeveritySchema } from "./release-version.ts";
import { ORI_DIRECTORY_NAME } from "../../ori-directory.ts";

/**
 * Durable record of a held auto-update awaiting approval, plus a checkpoint of
 * the last successful check. Stored at `<workspace>/.ori/auto-update.json` so
 * the auto-update loop does not re-notify on every tick and so `ori update` can
 * apply the exact held version out-of-band.
 */
const AUTO_UPDATE_STATE_FILE_NAME = "auto-update.json";

const JSON_INDENT = 2;

/**
 * The single source for the held-update decision literal set. `HeldUpdateDecision`
 * is derived from it, and it is reused as the persisted record's `decision` field
 * so the two never drift.
 */
const HeldUpdateDecisionSchema = Schema.Literals([
  "pending",
  "approved",
  "declined",
]).annotate({ identifier: "HeldUpdateDecision" });

type HeldUpdateDecision = typeof HeldUpdateDecisionSchema.Type;

// `approvalToken` and `decision` were added when Slack interactive approval
// landed; they decode-default so a held-update record written by an earlier
// (log-only) CLI version stays readable. Without this, an upgraded daemon would
// fail to decode the old record, treat it as absent, and re-notify the same
// held update once. Records the daemon writes always include both fields.
const PendingUpdateSchema = Schema.Struct({
  approvalToken: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed(""))
  ),
  currentVersion: Schema.NullOr(Schema.String),
  decision: HeldUpdateDecisionSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed("pending" as const))
  ),
  latestVersion: Schema.String,
  notifiedAt: Schema.String,
  severity: UpdateSeveritySchema,
});

const AutoUpdateStateSchema = Schema.Struct({
  lastCheckedAt: Schema.optionalKey(Schema.String),
  pending: Schema.optionalKey(PendingUpdateSchema),
});

const decodeAutoUpdateState = decodeJsonString(AutoUpdateStateSchema);

export type PendingUpdate = typeof PendingUpdateSchema.Type;
export type AutoUpdateState = typeof AutoUpdateStateSchema.Type;

export const autoUpdateStatePath = (
  path: Path.Path,
  workspaceRoot: string
): string =>
  path.join(workspaceRoot, ORI_DIRECTORY_NAME, AUTO_UPDATE_STATE_FILE_NAME);

/** Read the held-update state. Never fails: a missing or malformed file resolves to `None`. */
export const readAutoUpdateState = Effect.fn("AutoUpdateState.read")(function* (
  filePath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs
    .exists(filePath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return Option.none<AutoUpdateState>();
  }
  return yield* fs
    .readFileString(filePath)
    .pipe(Effect.flatMap(decodeAutoUpdateState), Effect.option);
});

/** Atomically write the held-update state next to the workspace's `.ori` directory. */
export const writeAutoUpdateState = Effect.fn("AutoUpdateState.write")(
  function* (filePath: string, state: AutoUpdateState) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmpPath = `${filePath}.tmp`;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    const serialized = yield* encodeJsonString(
      AutoUpdateStateSchema,
      JSON_INDENT
    )(state);
    yield* fs.writeFileString(tmpPath, `${serialized}\n`);
    yield* fs.rename(tmpPath, filePath);
  }
);

/** Drop any pending held-update record (e.g. after the update is applied), keeping the check timestamp. */
export const clearPendingUpdate = Effect.fn("AutoUpdateState.clearPending")(
  function* (filePath: string) {
    const current = yield* readAutoUpdateState(filePath);
    if (Option.isNone(current) || current.value.pending === undefined) {
      return;
    }
    const next: AutoUpdateState =
      current.value.lastCheckedAt === undefined
        ? {}
        : { lastCheckedAt: current.value.lastCheckedAt };
    yield* writeAutoUpdateState(filePath, next);
  }
);

/**
 * Whether a held update for `latestVersion` should be (re-)notified. We notify
 * when there is no pending record, or when the held version changed. An existing
 * `pending`/`declined` record for the *same* version is left alone so operators
 * are not pinged on every poll.
 */
export const shouldNotifyHeldUpdate = (
  state: Option.Option<AutoUpdateState>,
  latestVersion: string
): boolean => {
  if (Option.isNone(state)) {
    return true;
  }
  const { pending } = state.value;
  if (pending === undefined) {
    return true;
  }
  return pending.latestVersion !== latestVersion;
};

export {
  AUTO_UPDATE_STATE_FILE_NAME,
  AutoUpdateStateSchema,
  PendingUpdateSchema,
};
export type { HeldUpdateDecision };
