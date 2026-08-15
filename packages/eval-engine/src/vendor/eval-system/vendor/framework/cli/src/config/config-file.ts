import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { decodeJsonString } from "../../../contracts/internal/src/json.ts";
import { ROUTEKIT_EVAL_DIRECTORY_NAME } from "../routekit-eval-directory.ts";

/**
 * The shared, user-editable `config.json` file mechanics (RFC 0004 config.md):
 * the two scopes, resilient reads, the local-over-global per-field block merge,
 * and the merge-preserving block write. This is the neutral host owner the
 * feature-config resolver (RFC 0005 feature-config-access.md) is built on, and
 * the source of truth for the config path helpers the `routekit-eval update` blocks reuse.
 */
export const ROUTEKIT_EVAL_CONFIG_FILE_NAME = "config.json";
const JSON_INDENT = 2;

const ConfigObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
type ConfigObject = typeof ConfigObjectSchema.Type;
const decodeConfigObject = decodeJsonString(ConfigObjectSchema);
const decodeBlockObject = Schema.decodeUnknownEffect(ConfigObjectSchema);

export const globalRouteKitEvalConfigPath = (path: Path.Path, homeDir: string): string =>
  path.join(homeDir, ROUTEKIT_EVAL_DIRECTORY_NAME, ROUTEKIT_EVAL_CONFIG_FILE_NAME);

export const localRouteKitEvalConfigPath = (
  path: Path.Path,
  workspaceRoot: string
): string => path.join(workspaceRoot, ROUTEKIT_EVAL_DIRECTORY_NAME, ROUTEKIT_EVAL_CONFIG_FILE_NAME);

/**
 * Read and decode a single `config.json` into a plain object of blocks. Never
 * fails: a missing, unreadable, malformed-JSON, or non-object file resolves to
 * `None`, so one bad file never breaks resolution (RFC 0004 config.md resilience).
 */
const readConfigObject = Effect.fn("ConfigFile.readObject")(function* (
  filePath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs
    .exists(filePath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return Option.none<ConfigObject>();
  }
  return yield* fs
    .readFileString(filePath)
    .pipe(Effect.flatMap(decodeConfigObject), Effect.option);
});

/**
 * Resolve a named block merged local-over-global. When both scopes carry the
 * block as an object the merge is per field (local wins); otherwise the present
 * scope's value is returned as-is. Returns `undefined` when neither scope carries
 * the block. The caller decodes the raw value with its own schema.
 */
export const readMergedBlock = Effect.fn("ConfigFile.readMergedBlock")(
  function* (input: {
    readonly homeDir: string;
    readonly namespace: string;
    readonly workspaceRoot: string | undefined;
  }): Effect.fn.Return<unknown, never, FileSystem.FileSystem | Path.Path> {
    const path = yield* Path.Path;
    const globalObject = yield* readConfigObject(
      globalRouteKitEvalConfigPath(path, input.homeDir)
    );
    const localObject =
      input.workspaceRoot === undefined
        ? Option.none<ConfigObject>()
        : yield* readConfigObject(
            localRouteKitEvalConfigPath(path, input.workspaceRoot)
          );
    const globalBlock = Option.getOrUndefined(globalObject)?.[input.namespace];
    const localBlock = Option.getOrUndefined(localObject)?.[input.namespace];
    const globalRecord = yield* decodeBlockObject(globalBlock).pipe(
      Effect.option
    );
    const localRecord = yield* decodeBlockObject(localBlock).pipe(
      Effect.option
    );
    // Only a scope whose block decoded as an object may contribute, so a
    // malformed non-object block in one scope falls back to a valid block in the
    // other rather than shadowing it (RFC 0004 config.md per-field resilience).
    // Objects in both scopes merge local-over-global; a non-object in both
    // resolves as absent.
    if (Option.isSome(globalRecord) && Option.isSome(localRecord)) {
      return {
        ...globalRecord.value,
        ...localRecord.value,
      };
    }
    if (Option.isSome(localRecord)) {
      return localRecord.value;
    }
    return Option.getOrUndefined(globalRecord);
  }
);

/**
 * Merge-preserving write of a named block to a single `config.json`: read the
 * existing object (resiliently), replace only `namespace`, and write the result
 * back as pretty JSON so sibling blocks and unknown keys survive untouched.
 */
export const writeBlock = Effect.fn("ConfigFile.writeBlock")(function* (input: {
  readonly namespace: string;
  readonly targetPath: string;
  readonly value: unknown;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const existing = yield* readConfigObject(input.targetPath);
  const base = Option.getOrElse(existing, () => ({}) as ConfigObject);
  const next: ConfigObject = {
    ...base,
    [input.namespace]: input.value,
  };
  yield* fs.makeDirectory(path.dirname(input.targetPath), { recursive: true });
  // config.json is human-editable, so it is written as pretty JSON. Schema
  // encoding does not pretty-print, so a direct stringify is intentional here.
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  const serialized = `${JSON.stringify(next, null, JSON_INDENT)}\n`;
  yield* fs.writeFileString(input.targetPath, serialized);
});
