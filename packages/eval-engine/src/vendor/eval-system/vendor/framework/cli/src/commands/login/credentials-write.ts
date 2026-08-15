import { Effect, FileSystem, Path } from "effect";

import type { AuthStorageScope } from "../../routekit-eval-directory.ts";

import {
  CliFailureError,
  makeCliFailureFromCause,
} from "../../../../contracts/internal/src/errors.ts";
import { encodeJsonString } from "../../../../contracts/internal/src/json.ts";
import {
  resolveAuthPath,
  resolveGlobalAuthPath,
} from "../../routekit-eval-directory.ts";

import type { AuthCredentials } from "./credentials-resolve.ts";

import { AuthCredentialsSchema } from "./credentials-resolve.ts";

const AUTH_TMP_SUFFIX = ".tmp";
const AUTH_FILE_MODE = 0o600;
const JSON_INDENT = 2;

export interface WriteAuthCredentialsInput {
  readonly credentials: AuthCredentials;
  readonly scope: AuthStorageScope;
  readonly startDir: string;
}

const writeCredentialsFileEffect = Effect.fn("LoginCredentials.writeFile")(
  function* (input: {
    readonly credentials: AuthCredentials;
    readonly targetPath: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmpPath = `${input.targetPath}${AUTH_TMP_SUFFIX}`;
    const encoded = yield* encodeJsonString(
      AuthCredentialsSchema,
      JSON_INDENT
    )(input.credentials);
    const serialized = `${encoded}\n`;
    yield* fs.makeDirectory(path.dirname(input.targetPath), {
      recursive: true,
    });
    yield* fs.writeFileString(tmpPath, serialized, { mode: AUTH_FILE_MODE });
    yield* fs.rename(tmpPath, input.targetPath);
    yield* fs.chmod(input.targetPath, AUTH_FILE_MODE).pipe(Effect.ignore);
  }
);

const writeCredentialsFile = (input: {
  readonly credentials: AuthCredentials;
  readonly targetPath: string;
}): Effect.Effect<void, CliFailureError, FileSystem.FileSystem | Path.Path> =>
  writeCredentialsFileEffect(input).pipe(
    Effect.mapError(
      makeCliFailureFromCause("Failed to save Gateway credentials")
    )
  );

export const writeAuthCredentials = Effect.fn("LoginCredentials.write")(
  function* (input: WriteAuthCredentialsInput) {
    const globalPath = yield* resolveGlobalAuthPath();
    const targetPath = yield* resolveAuthPath({
      scope: input.scope,
      startDir: input.startDir,
    }).pipe(
      Effect.mapError(
        (error) =>
          new CliFailureError({
            detail: `Could not find a workspace root (a directory containing 'features/') at or above ${error.startDir}. Run without --local to save the key to ${globalPath}.`,
          })
      )
    );
    yield* writeCredentialsFile({
      credentials: input.credentials,
      targetPath,
    });
    return targetPath;
  }
);
