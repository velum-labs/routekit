import { Effect, FileSystem, Option, Path, Schema } from "effect";

import type { UpdateChannel } from "./release-channel.ts";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import {
  decodeJsonString,
  encodeJsonString,
} from "../../../../contracts/internal/src/json.ts";
import { globalOriConfigPath } from "./ori-config.ts";
import { optionalLenientField } from "./ori-config-schema.ts";
import {
  ALPHA_CHANNEL,
  UpdateChannelSchema,
} from "./release-channel.ts";

/**
 * The `ori code` early-access opt-in, persisted at the top level of the global
 * `~/.ori/config.json`. Absent means not recorded (an interactive launch may
 * ask once); `true` opts the launch check into alpha, `false` is a remembered
 * "stay on stable". Explicit update channel selections are persisted separately
 * as `channel`, with both values kept consistent when written together.
 */
const EARLY_ACCESS_CONFIG_KEY = "earlyAccess";
const CHANNEL_CONFIG_KEY = "channel";
const CONFIG_JSON_INDENT = 2;

/**
 * The whole file as an opaque key/value object. Used only by the writer so
 * recording one key preserves every other field on disk.
 */
const OriConfigRawObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeOriConfigRawObject = decodeJsonString(OriConfigRawObjectSchema);

/**
 * A read view of `config.json` that models ONLY `earlyAccess`. `Schema.Struct`
 * ignores excess properties by default, so this decodes even when an unrelated
 * field (e.g. a malformed `autoUpdate` block) is present — keeping the "have we
 * asked?" read symmetric with the writer's lenient raw merge.
 */
const EarlyAccessConfigSchema = Schema.Struct({
  channel: optionalLenientField(UpdateChannelSchema),
  earlyAccess: optionalLenientField(Schema.Boolean),
});
const decodeEarlyAccessConfig = decodeJsonString(EarlyAccessConfigSchema);

/**
 * Read the global `~/.ori/config.json` through the narrow
 * {@link EarlyAccessConfigSchema} rather than the whole-file schema, so an
 * unrelated malformed value cannot make a recorded preference read back as
 * "never set" and re-prompt every launch. `None` covers a missing, unreadable,
 * or undecodable file — never fails.
 */
const readEarlyAccessConfig = Effect.fn("OriConfig.readEarlyAccessConfig")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostProcess = yield* HostProcess;
    const homeDir = yield* hostProcess.homeDirectory;
    return yield* fs
      .readFileString(globalOriConfigPath(path, homeDir))
      .pipe(Effect.flatMap(decodeEarlyAccessConfig), Effect.option);
  }
);

/**
 * Read the recorded `ori code` early-access preference. `None` means not asked
 * yet; `Some` carries the choice.
 */
export const readEarlyAccessPreference = Effect.fn("OriConfig.readEarlyAccess")(
  function* () {
    const config = yield* readEarlyAccessConfig();
    return config.pipe(
      Option.flatMap((file) =>
        file.earlyAccess === undefined
          ? Option.none<boolean>()
          : Option.some(file.earlyAccess)
      )
    );
  }
);

export const readChannelPreference = Effect.fn("OriConfig.readChannel")(
  function* () {
    const config = yield* readEarlyAccessConfig();
    return config.pipe(
      Option.flatMap((file) =>
        file.channel === undefined
          ? Option.none<UpdateChannel>()
          : Option.some(file.channel)
      )
    );
  }
);

const writeConfigKeys = Effect.fn("OriConfig.writeKeys")(function* (
  updates: Readonly<Record<string, unknown>>
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostProcess = yield* HostProcess;
  const homeDir = yield* hostProcess.homeDirectory;
  const filePath = globalOriConfigPath(path, homeDir);
  const existing = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeOriConfigRawObject),
    Effect.orElseSucceed(() => ({}) as Record<string, unknown>)
  );
  const merged = {
    ...existing,
    ...updates,
  };
  const tmpPath = `${filePath}.tmp`;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  const serialized = yield* encodeJsonString(
    OriConfigRawObjectSchema,
    CONFIG_JSON_INDENT
  )(merged);
  yield* fs.writeFileString(tmpPath, `${serialized}\n`);
  yield* fs.rename(tmpPath, filePath);
});

/**
 * Atomically record the `ori code` early-access preference in the global
 * `~/.ori/config.json`, merging into the existing file so the write never
 * clobbers the `autoUpdate` block or any other key already on disk.
 */
export const recordEarlyAccessPreference = Effect.fn(
  "OriConfig.recordEarlyAccess"
)(function* (joinEarlyAccess: boolean) {
  yield* writeConfigKeys({
    [EARLY_ACCESS_CONFIG_KEY]: joinEarlyAccess,
  });
});

export const recordChannelPreference = Effect.fn("OriConfig.recordChannel")(
  function* (channel: UpdateChannel) {
    yield* writeConfigKeys({
      [CHANNEL_CONFIG_KEY]: channel,
      [EARLY_ACCESS_CONFIG_KEY]: channel === ALPHA_CHANNEL,
    });
  }
);
