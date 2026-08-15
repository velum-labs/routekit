import { Clock, Crypto, Effect, FileSystem, Path, Schema } from "effect";

import { HostProcess } from "../../../contracts/internal/src/cli/host-process.ts";
import {
  decodeJsonString,
  encodeJsonString,
} from "../../../contracts/internal/src/json.ts";
import { ROUTEKIT_EVAL_DIRECTORY_NAME } from "../routekit-eval-directory.ts";

/**
 * Persistent telemetry identity per RFC 0012: `~/.routekit-eval/telemetry.json` holds
 * the anonymous `install_id` (a UUIDv4 generated lazily on first telemetry
 * use, never by the installer) plus the two one-shot markers — whether the
 * first-run disclosure notice was printed and whether `install_first_run`
 * was emitted.
 */

const TELEMETRY_STATE_FILE_NAME = "telemetry.json";

const TelemetryStateSchema = Schema.Struct({
  firstRunSent: Schema.Boolean,
  firstAgentRunSent: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  installedAtMs: Schema.optionalKey(Schema.UndefinedOr(Schema.Int)),
  installId: Schema.String,
  noticeShown: Schema.Boolean,
});

type TelemetryState = typeof TelemetryStateSchema.Type;

export const telemetryStatePath = Effect.fn("Telemetry.statePath")(
  function* () {
    const hostProcess = yield* HostProcess;
    const path = yield* Path.Path;
    const homeDir = yield* hostProcess.homeDirectory;
    return path.join(homeDir, ROUTEKIT_EVAL_DIRECTORY_NAME, TELEMETRY_STATE_FILE_NAME);
  }
);

const freshState = Effect.fn("Telemetry.freshState")(function* () {
  const cryptoService = yield* Crypto.Crypto;
  const installId = yield* cryptoService.randomUUIDv4;
  return {
    firstRunSent: false,
    firstAgentRunSent: false,
    installedAtMs: yield* Clock.currentTimeMillis,
    installId,
    noticeShown: false,
  } satisfies TelemetryState;
});

export const writeTelemetryState = Effect.fn("Telemetry.writeState")(function* (
  state: TelemetryState
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = yield* telemetryStatePath();
  yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
  const now = yield* Clock.currentTimeMillis;
  const current = yield* fs.readFileString(statePath).pipe(
    Effect.flatMap((raw) => decodeJsonString(TelemetryStateSchema)(raw)),
    Effect.option
  );
  const merged =
    current._tag === "Some"
      ? {
          ...state,
          firstAgentRunSent:
            current.value.firstAgentRunSent === true ||
            state.firstAgentRunSent === true,
          firstRunSent: current.value.firstRunSent || state.firstRunSent,
          installedAtMs: Math.min(
            current.value.installedAtMs ?? state.installedAtMs ?? now,
            state.installedAtMs ?? now
          ),
          installId: current.value.installId,
          noticeShown: current.value.noticeShown || state.noticeShown,
        }
      : state;
  const serialized = yield* encodeJsonString(TelemetryStateSchema, 2)(merged);
  const temporaryPath = `${statePath}.${merged.installId}.${now}.${Math.random()}.tmp`;
  yield* fs.writeFileString(temporaryPath, `${serialized}\n`).pipe(
    Effect.flatMap(() => fs.rename(temporaryPath, statePath)),
    Effect.catchCause((cause) =>
      fs
        .remove(temporaryPath, { recursive: false })
        .pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause)))
    )
  );
});

/**
 * Read the persisted state, creating it (and the install id) on first use.
 * Every failure collapses to a fresh in-memory state: telemetry must never
 * surface an error, so an unreadable file just means a new anonymous id.
 */
export const readOrCreateTelemetryState = Effect.fn("Telemetry.readOrCreate")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const statePath = yield* telemetryStatePath();

    const existing = yield* fs.readFileString(statePath).pipe(
      Effect.flatMap((raw) => decodeJsonString(TelemetryStateSchema)(raw)),
      Effect.option
    );
    if (existing._tag === "Some") {
      return existing.value;
    }

    const state = yield* freshState();
    yield* writeTelemetryState(state).pipe(Effect.ignore);
    return state;
  }
);

export type { TelemetryState };
