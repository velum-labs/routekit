import type { FileSystem } from "effect";

import { Effect, Option, Path } from "effect";

import type { OpenRouterAuthSource } from "../../../../contracts/internal/src/openrouter-auth.ts";
import type { OriDirectory } from "../../ori-directory.ts";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { OPENROUTER_API_KEY_ENV } from "../../../../contracts/internal/src/openrouter-auth.ts";
import { RuntimeSecretStore } from "../../../../contracts/internal/src/runtime/runtime-secret-store.ts";
import { RuntimeSecretName } from "../../../../contracts/internal/src/runtime/services.ts";

import type {
  AuthCredentials,
  LoadCredentialsLocation,
  StoredCredentialResolutionOptions,
} from "./credentials-resolve.ts";
import type { WriteAuthCredentialsInput } from "./credentials-write.ts";

import {
  forceEnvironmentOpenRouterKey,
  findProjectBoundary,
  inheritedOpenRouterKeyFromProcfs,
  isDotenvOpenRouterKey,
  parseDotenvOpenRouterApiKey,
  resolveDotenvOpenRouterKey,
  restoreDotenvOpenRouterCredential,
} from "./credentials-provenance.ts";
import {
  globalAuthPath,
  globalCredentialFallbackPath,
  localAuthPath,
  localRunCredentialPath,
  readAuthCredentials,
  resolveStoredCredential,
} from "./credentials-resolve.ts";
import { writeAuthCredentials } from "./credentials-write.ts";

interface LoadStoredOpenRouterKeyOptions extends StoredCredentialResolutionOptions {
  readonly overrideExistingEnv?: boolean;
  readonly procfsAnswerForTest?: boolean;
}
const environmentOpenRouterAuthSource: OpenRouterAuthSource = {
  kind: "environment",
  location: OPENROUTER_API_KEY_ENV,
};
// Captures the stored value bootstrap wrote into the live environment so
// source reporting can distinguish it from the startup classification.
let resolvedOpenRouterCredentialAtStartup:
  | { readonly value: string; readonly source: OpenRouterAuthSource }
  | undefined;

const hasOpenRouterKeyInEnv = Effect.fn("LoginCredentials.hasOpenRouterKey")(
  function* () {
    const secrets = yield* RuntimeSecretStore;
    const key = yield* secrets.get(RuntimeSecretName.OpenRouterApiKey);
    return Option.isSome(key);
  }
);

// Captured before bootstrap can replace the live environment with stored auth.
// `true` means inherited, `false` means project-attributed, and `undefined`
// means no startup key was captured.
let ambientOpenRouterKeyAtStartup: boolean | undefined;
// Preserve the project value and source so later gates cannot report a stored
// replacement as dotenv.
let dotenvOpenRouterCredentialAtStartup:
  | { readonly source: OpenRouterAuthSource; readonly value: string }
  | undefined;

const resetAmbientOpenRouterKeyForTest = (): void => {
  ambientOpenRouterKeyAtStartup = undefined;
  dotenvOpenRouterCredentialAtStartup = undefined;
  resolvedOpenRouterCredentialAtStartup = undefined;
};

export { parseDotenvOpenRouterApiKey };

export const resolveOpenRouterAuthSource = Effect.fn(
  "LoginCredentials.resolveAuthSource"
)(function* (startDir: string, procfsAnswer?: boolean) {
  if (!(yield* hasOpenRouterKeyInEnv())) {
    return Option.none<OpenRouterAuthSource>();
  }
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  const currentValue = env[OPENROUTER_API_KEY_ENV];
  if (currentValue === undefined) {
    return Option.none<OpenRouterAuthSource>();
  }
  if (yield* forceEnvironmentOpenRouterKey()) {
    return Option.some(environmentOpenRouterAuthSource);
  }
  if (
    ambientOpenRouterKeyAtStartup !== undefined &&
    resolvedOpenRouterCredentialAtStartup?.value === currentValue
  ) {
    return Option.some(resolvedOpenRouterCredentialAtStartup.source);
  }
  if (
    ambientOpenRouterKeyAtStartup === false &&
    dotenvOpenRouterCredentialAtStartup?.value === currentValue
  ) {
    return Option.some(dotenvOpenRouterCredentialAtStartup.source);
  }
  const inheritedKey = yield* inheritedOpenRouterKeyFromProcfs(
    currentValue,
    procfsAnswer
  );
  if (Option.isSome(inheritedKey)) {
    if (inheritedKey.value) {
      return Option.some(environmentOpenRouterAuthSource);
    }
    const dotenvSource = yield* isDotenvOpenRouterKey(startDir, true);
    return Option.isSome(dotenvSource)
      ? dotenvSource
      : Option.some(environmentOpenRouterAuthSource);
  }
  const dotenvSource = yield* isDotenvOpenRouterKey(startDir);
  return Option.isSome(dotenvSource)
    ? dotenvSource
    : Option.some(environmentOpenRouterAuthSource);
});
const hasResolvableOpenRouterCredentialEffect = Effect.fn(
  "LoginCredentials.hasResolvable"
)(function* (location: LoadCredentialsLocation) {
  if (yield* hasOpenRouterKeyInEnv()) {
    return true;
  }
  const credential = yield* resolveStoredCredential(location);
  return Option.isSome(credential);
});
const hasResolvableOpenRouterCredential = (
  location: LoadCredentialsLocation
): Effect.Effect<
  boolean,
  never,
  | FileSystem.FileSystem
  | HostProcess
  | OriDirectory
  | Path.Path
  | RuntimeSecretStore
> =>
  hasResolvableOpenRouterCredentialEffect(location).pipe(
    Effect.orElseSucceed(() => false)
  );
const captureAmbientOpenRouterKey = Effect.fn(
  "LoginCredentials.captureAmbientKey"
)(function* (startDir?: string, procfsAnswer?: boolean) {
  const hostProcess = yield* HostProcess;
  const cwd = startDir ?? (yield* hostProcess.currentWorkingDirectory);
  const hasKey = yield* hasOpenRouterKeyInEnv();
  if (!hasKey) {
    ambientOpenRouterKeyAtStartup = false;
    dotenvOpenRouterCredentialAtStartup = undefined;
    return;
  }
  const currentValue = (yield* hostProcess.env)[OPENROUTER_API_KEY_ENV];
  if (currentValue === undefined) {
    ambientOpenRouterKeyAtStartup = false;
    dotenvOpenRouterCredentialAtStartup = undefined;
    return;
  }
  if (yield* forceEnvironmentOpenRouterKey()) {
    ambientOpenRouterKeyAtStartup = true;
    dotenvOpenRouterCredentialAtStartup = undefined;
    return;
  }
  const inheritedKey = yield* inheritedOpenRouterKeyFromProcfs(
    currentValue,
    procfsAnswer
  );
  if (Option.isSome(inheritedKey)) {
    ambientOpenRouterKeyAtStartup = inheritedKey.value;
    dotenvOpenRouterCredentialAtStartup = undefined;
    if (inheritedKey.value) {
      return;
    }
  }
  const allowAnyDeclaration =
    Option.isSome(inheritedKey) && !inheritedKey.value;
  const projectBoundary = allowAnyDeclaration
    ? yield* findProjectBoundary(cwd)
    : undefined;
  const dotenvCredential = yield* resolveDotenvOpenRouterKey(
    cwd,
    undefined,
    projectBoundary === undefined
      ? {
          allowAnyDeclaration,
        }
      : {
          allowAnyDeclaration,
          workspaceRoot: projectBoundary,
        }
  );
  const projectCredential = Option.isSome(dotenvCredential);
  ambientOpenRouterKeyAtStartup = !projectCredential;
  dotenvOpenRouterCredentialAtStartup = projectCredential
    ? dotenvCredential.value
    : undefined;
});
const hasAmbientOpenRouterKey = Effect.fn("LoginCredentials.hasAmbientKey")(
  function* () {
    if (ambientOpenRouterKeyAtStartup !== undefined) {
      return ambientOpenRouterKeyAtStartup;
    }
    return yield* hasOpenRouterKeyInEnv();
  }
);
const projectOpenRouterAuthSourceAtStartup = (): Effect.Effect<
  Option.Option<OpenRouterAuthSource>
> =>
  Effect.succeed(
    Option.fromUndefinedOr(dotenvOpenRouterCredentialAtStartup).pipe(
      Option.map(({ source }) => source)
    )
  );
const restoreDotenvOpenRouterCredentialAtStartup = Effect.fn(
  "LoginCredentials.restoreDotenvCredentialAtStartup"
)(function* (workspaceRoot?: string) {
  const credential = Option.fromUndefinedOr(
    dotenvOpenRouterCredentialAtStartup
  );
  if (Option.isNone(credential)) {
    return Option.none<OpenRouterAuthSource>();
  }
  let candidate = credential.value;
  if (workspaceRoot !== undefined) {
    const path = yield* Path.Path;
    const relativeLocation = path.relative(
      workspaceRoot,
      candidate.source.location
    );
    if (!relativeLocation.startsWith("..")) {
      return yield* restoreDotenvOpenRouterCredential(candidate);
    }
    const resolved = yield* resolveDotenvOpenRouterKey(
      workspaceRoot,
      candidate.value,
      {
        allowAnyDeclaration: true,
        workspaceRoot,
      }
    );
    if (Option.isNone(resolved)) {
      return Option.none<OpenRouterAuthSource>();
    }
    candidate = resolved.value;
  }
  return yield* restoreDotenvOpenRouterCredential(candidate);
});
const loadStoredOpenRouterKeyIntoEnvFromEffect = Effect.fn(
  "LoginCredentials.loadIntoEnvFrom"
)(function* (input: {
  readonly location: LoadCredentialsLocation;
  readonly options: LoadStoredOpenRouterKeyOptions;
}) {
  const { location, options } = input;
  if (ambientOpenRouterKeyAtStartup === undefined) {
    resolvedOpenRouterCredentialAtStartup = undefined;
  }
  const hostProcess = yield* HostProcess;
  const existingSource =
    options.overrideExistingEnv === true
      ? Option.none<OpenRouterAuthSource>()
      : yield* resolveOpenRouterAuthSource(
          location.startDir,
          options.procfsAnswerForTest
        );
  if (
    options.overrideExistingEnv !== true &&
    Option.isSome(existingSource) &&
    existingSource.value.kind === "environment"
  ) {
    const value = (yield* hostProcess.env)[OPENROUTER_API_KEY_ENV];
    if (value !== undefined) {
      resolvedOpenRouterCredentialAtStartup = {
        source: existingSource.value,
        value,
      };
    }
    return existingSource;
  }
  const credential = yield* resolveStoredCredential(location, options);
  if (Option.isSome(credential)) {
    yield* hostProcess.setEnv(
      OPENROUTER_API_KEY_ENV,
      credential.value.credentials.key
    );
    resolvedOpenRouterCredentialAtStartup = {
      source: credential.value.source,
      value: credential.value.credentials.key,
    };
    return Option.some(credential.value.source);
  }
  if (options.overrideExistingEnv === true) {
    return Option.none<OpenRouterAuthSource>();
  }
  if (Option.isSome(existingSource)) {
    const value = (yield* hostProcess.env)[OPENROUTER_API_KEY_ENV];
    if (value !== undefined) {
      resolvedOpenRouterCredentialAtStartup = {
        source: existingSource.value,
        value,
      };
    }
  }
  return existingSource;
});
export const loadStoredOpenRouterKeyIntoEnvFrom = (
  location: LoadCredentialsLocation,
  options?: LoadStoredOpenRouterKeyOptions
): Effect.Effect<
  Option.Option<OpenRouterAuthSource>,
  never,
  | FileSystem.FileSystem
  | HostProcess
  | OriDirectory
  | Path.Path
  | RuntimeSecretStore
> =>
  loadStoredOpenRouterKeyIntoEnvFromEffect({
    location,
    options: options ?? { includeGlobal: true },
  }).pipe(Effect.orElseSucceed(() => Option.none<OpenRouterAuthSource>()));
export const loadStoredOpenRouterKeyIntoEnv = Effect.fn(
  "LoginCredentials.loadIntoEnv"
)(function* () {
  const hostProcess = yield* HostProcess;
  yield* loadStoredOpenRouterKeyIntoEnvFrom({
    startDir: yield* hostProcess.currentWorkingDirectory,
  });
});
export {
  globalAuthPath,
  localAuthPath,
  localRunCredentialPath,
  globalCredentialFallbackPath,
  readAuthCredentials,
  resetAmbientOpenRouterKeyForTest,
  writeAuthCredentials,
  hasOpenRouterKeyInEnv,
  hasResolvableOpenRouterCredential,
  captureAmbientOpenRouterKey,
  hasAmbientOpenRouterKey,
  projectOpenRouterAuthSourceAtStartup,
  restoreDotenvOpenRouterCredentialAtStartup,
  environmentOpenRouterAuthSource,
};
export type {
  AuthCredentials,
  LoadCredentialsLocation,
  LoadStoredOpenRouterKeyOptions,
  WriteAuthCredentialsInput,
};
