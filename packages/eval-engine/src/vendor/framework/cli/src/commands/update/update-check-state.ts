import { Effect, FileSystem, Path, Schema } from "effect";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import {
  decodeJsonString,
  encodeJsonString,
} from "../../../../contracts/internal/src/json.ts";
import { UpdateChannelSchema } from "./release-channel.ts";
import { ORI_DIRECTORY_NAME } from "../../ori-directory.ts";

const UPDATE_CHECK_STATE_FILE_NAME = "update-check.json";
const JSON_INDENT = 2;

const UpdateCheckStateSchema = Schema.Struct({
  autoUpdateOnCodeLaunch: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false))
  ),
  // The channel the cached `latestVersion` was observed on, so the network-free
  // banner can point at the matching `ori update` invocation instead of always
  // suggesting the stable channel for an early-access user's alpha build.
  channel: Schema.optionalKey(UpdateChannelSchema),
  checkedAt: Schema.optionalKey(Schema.String),
  latestVersion: Schema.optionalKey(Schema.String),
});

const DEFAULT_UPDATE_CHECK_STATE: UpdateCheckState = {
  autoUpdateOnCodeLaunch: false,
};

export type UpdateCheckState = typeof UpdateCheckStateSchema.Type;

export const updateCheckStatePath = Effect.fn("UpdateCheckState.path")(
  function* () {
    const hostProcess = yield* HostProcess;
    const path = yield* Path.Path;
    const homeDirectory = yield* hostProcess.homeDirectory;
    return path.join(
      homeDirectory,
      ORI_DIRECTORY_NAME,
      UPDATE_CHECK_STATE_FILE_NAME
    );
  }
);

export const readUpdateCheckState = Effect.fn("UpdateCheckState.read")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const filePath = yield* updateCheckStatePath();
    return yield* fs.readFileString(filePath).pipe(
      Effect.flatMap(decodeJsonString(UpdateCheckStateSchema)),
      Effect.orElseSucceed((): UpdateCheckState => DEFAULT_UPDATE_CHECK_STATE)
    );
  }
);

export const writeUpdateCheckState = Effect.fn("UpdateCheckState.write")(
  function* (state: UpdateCheckState) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = yield* updateCheckStatePath();
    const tmpPath = `${filePath}.tmp`;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    const serialized = yield* encodeJsonString(
      UpdateCheckStateSchema,
      JSON_INDENT
    )(state);
    yield* fs.writeFileString(tmpPath, `${serialized}\n`);
    yield* fs.rename(tmpPath, filePath);
  }
);

export { UPDATE_CHECK_STATE_FILE_NAME, UpdateCheckStateSchema };
