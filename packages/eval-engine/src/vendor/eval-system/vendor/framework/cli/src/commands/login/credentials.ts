import type { FileSystem } from "effect";

import { Effect, Option, Path } from "effect";

import type { GatewayAuthSource } from "../../../../contracts/internal/src/gateway-auth.ts";
import type { RouteKitEvalDirectory } from "../../routekit-eval-directory.ts";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { ROUTEKIT_EVAL_BEARER_TOKEN_ENV } from "../../../../contracts/internal/src/gateway-auth.ts";
import { RuntimeSecretStore } from "../../../../contracts/internal/src/runtime/runtime-secret-store.ts";
import { RuntimeSecretName } from "../../../../contracts/internal/src/runtime/services.ts";

import type {
  AuthCredentials,
  LoadCredentialsLocation,
  StoredCredentialResolutionOptions,
} from "./credentials-resolve.ts";
import type { WriteAuthCredentialsInput } from "./credentials-write.ts";

import {
  forceEnvironmentGatewayKey,
  findProjectBoundary,
  inheritedGatewayKeyFromProcfs,
  isDotenvGatewayKey,
  parseDotenvGatewayApiKey,
  resolveDotenvGatewayKey,
  restoreDotenvGatewayCredential,
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

interface LoadStoredGatewayKeyOptions extends StoredCredentialResolutionOptions {
  readonly overrideExistingEnv?: boolean;
  readonly procfsAnswerForTest?: boolean;
}
const environmentGatewayAuthSource: GatewayAuthSource = {
  kind: "environment",
  location: ROUTEKIT_EVAL_BEARER_TOKEN_ENV,
};
// Captures the stored value bootstrap wrote into the live environment so
// source reporting can distinguish it from the startup classification.
let resolvedGatewayCredentialAtStartup:
  | { readonly value: string; readonly source: GatewayAuthSource }
  | undefined;

const hasGatewayKeyInEnv = Effect.fn("LoginCredentials.hasGatewayKey")(
  function* () {
    const secrets = yield* RuntimeSecretStore;
    const key = yield* secrets.get(RuntimeSecretName.GatewayApiKey);
    return Option.isSome(key);
  }
);

// Captured before bootstrap can replace the live environment with stored auth.
// `true` means inherited, `false` means project-attributed, and `undefined`
// means no startup key was captured.
let ambientGatewayKeyAtStartup: boolean | undefined;
// Preserve the project value and source so later gates cannot report a stored
// replacement as dotenv.
let dotenvGatewayCredentialAtStartup:
  | { readonly source: GatewayAuthSource; readonly value: string }
  | undefined;

const resetAmbientGatewayKeyForTest = (): void => {
  ambientGatewayKeyAtStartup = undefined;
  dotenvGatewayCredentialAtStartup = undefined;
  resolvedGatewayCredentialAtStartup = undefined;
};

export { parseDotenvGatewayApiKey };

export const resolveGatewayAuthSource = Effect.fn(
  "LoginCredentials.resolveAuthSource"
)(function* (startDir: string, procfsAnswer?: boolean) {
  if (!(yield* hasGatewayKeyInEnv())) {
    return Option.none<GatewayAuthSource>();
  }
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  const currentValue = env[ROUTEKIT_EVAL_BEARER_TOKEN_ENV];
  if (currentValue === undefined) {
    return Option.none<GatewayAuthSource>();
  }
  if (yield* forceEnvironmentGatewayKey()) {
    return Option.some(environmentGatewayAuthSource);
  }
  if (
    ambientGatewayKeyAtStartup !== undefined &&
    resolvedGatewayCredentialAtStartup?.value === currentValue
  ) {
    return Option.some(resolvedGatewayCredentialAtStartup.source);
  }
  if (
    ambientGatewayKeyAtStartup === false &&
    dotenvGatewayCredentialAtStartup?.value === currentValue
  ) {
    return Option.some(dotenvGatewayCredentialAtStartup.source);
  }
  const inheritedKey = yield* inheritedGatewayKeyFromProcfs(
    currentValue,
    procfsAnswer
  );
  if (Option.isSome(inheritedKey)) {
    if (inheritedKey.value) {
      return Option.some(environmentGatewayAuthSource);
    }
    const dotenvSource = yield* isDotenvGatewayKey(startDir, true);
    return Option.isSome(dotenvSource)
      ? dotenvSource
      : Option.some(environmentGatewayAuthSource);
  }
  const dotenvSource = yield* isDotenvGatewayKey(startDir);
  return Option.isSome(dotenvSource)
    ? dotenvSource
    : Option.some(environmentGatewayAuthSource);
});
const hasResolvableGatewayCredentialEffect = Effect.fn(
  "LoginCredentials.hasResolvable"
)(function* (location: LoadCredentialsLocation) {
  if (yield* hasGatewayKeyInEnv()) {
    return true;
  }
  const credential = yield* resolveStoredCredential(location);
  return Option.isSome(credential);
});
const hasResolvableGatewayCredential = (
  location: LoadCredentialsLocation
): Effect.Effect<
  boolean,
  never,
  | FileSystem.FileSystem
  | HostProcess
  | RouteKitEvalDirectory
  | Path.Path
  | RuntimeSecretStore
> =>
  hasResolvableGatewayCredentialEffect(location).pipe(
    Effect.orElseSucceed(() => false)
  );
const captureAmbientGatewayKey = Effect.fn(
  "LoginCredentials.captureAmbientKey"
)(function* (startDir?: string, procfsAnswer?: boolean) {
  const hostProcess = yield* HostProcess;
  const cwd = startDir ?? (yield* hostProcess.currentWorkingDirectory);
  const hasKey = yield* hasGatewayKeyInEnv();
  if (!hasKey) {
    ambientGatewayKeyAtStartup = false;
    dotenvGatewayCredentialAtStartup = undefined;
    return;
  }
  const currentValue = (yield* hostProcess.env)[ROUTEKIT_EVAL_BEARER_TOKEN_ENV];
  if (currentValue === undefined) {
    ambientGatewayKeyAtStartup = false;
    dotenvGatewayCredentialAtStartup = undefined;
    return;
  }
  if (yield* forceEnvironmentGatewayKey()) {
    ambientGatewayKeyAtStartup = true;
    dotenvGatewayCredentialAtStartup = undefined;
    return;
  }
  const inheritedKey = yield* inheritedGatewayKeyFromProcfs(
    currentValue,
    procfsAnswer
  );
  if (Option.isSome(inheritedKey)) {
    ambientGatewayKeyAtStartup = inheritedKey.value;
    dotenvGatewayCredentialAtStartup = undefined;
    if (inheritedKey.value) {
      return;
    }
  }
  const allowAnyDeclaration =
    Option.isSome(inheritedKey) && !inheritedKey.value;
  const projectBoundary = allowAnyDeclaration
    ? yield* findProjectBoundary(cwd)
    : undefined;
  const dotenvCredential = yield* resolveDotenvGatewayKey(
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
  ambientGatewayKeyAtStartup = !projectCredential;
  dotenvGatewayCredentialAtStartup = projectCredential
    ? dotenvCredential.value
    : undefined;
});
const hasAmbientGatewayKey = Effect.fn("LoginCredentials.hasAmbientKey")(
  function* () {
    if (ambientGatewayKeyAtStartup !== undefined) {
      return ambientGatewayKeyAtStartup;
    }
    return yield* hasGatewayKeyInEnv();
  }
);
const projectGatewayAuthSourceAtStartup = (): Effect.Effect<
  Option.Option<GatewayAuthSource>
> =>
  Effect.succeed(
    Option.fromUndefinedOr(dotenvGatewayCredentialAtStartup).pipe(
      Option.map(({ source }) => source)
    )
  );
const restoreDotenvGatewayCredentialAtStartup = Effect.fn(
  "LoginCredentials.restoreDotenvCredentialAtStartup"
)(function* (workspaceRoot?: string) {
  const credential = Option.fromUndefinedOr(
    dotenvGatewayCredentialAtStartup
  );
  if (Option.isNone(credential)) {
    return Option.none<GatewayAuthSource>();
  }
  let candidate = credential.value;
  if (workspaceRoot !== undefined) {
    const path = yield* Path.Path;
    const relativeLocation = path.relative(
      workspaceRoot,
      candidate.source.location
    );
    if (!relativeLocation.startsWith("..")) {
      return yield* restoreDotenvGatewayCredential(candidate);
    }
    const resolved = yield* resolveDotenvGatewayKey(
      workspaceRoot,
      candidate.value,
      {
        allowAnyDeclaration: true,
        workspaceRoot,
      }
    );
    if (Option.isNone(resolved)) {
      return Option.none<GatewayAuthSource>();
    }
    candidate = resolved.value;
  }
  return yield* restoreDotenvGatewayCredential(candidate);
});
const loadStoredGatewayKeyIntoEnvFromEffect = Effect.fn(
  "LoginCredentials.loadIntoEnvFrom"
)(function* (input: {
  readonly location: LoadCredentialsLocation;
  readonly options: LoadStoredGatewayKeyOptions;
}) {
  const { location, options } = input;
  if (ambientGatewayKeyAtStartup === undefined) {
    resolvedGatewayCredentialAtStartup = undefined;
  }
  const hostProcess = yield* HostProcess;
  const existingSource =
    options.overrideExistingEnv === true
      ? Option.none<GatewayAuthSource>()
      : yield* resolveGatewayAuthSource(
          location.startDir,
          options.procfsAnswerForTest
        );
  if (
    options.overrideExistingEnv !== true &&
    Option.isSome(existingSource) &&
    existingSource.value.kind === "environment"
  ) {
    const value = (yield* hostProcess.env)[ROUTEKIT_EVAL_BEARER_TOKEN_ENV];
    if (value !== undefined) {
      resolvedGatewayCredentialAtStartup = {
        source: existingSource.value,
        value,
      };
    }
    return existingSource;
  }
  const credential = yield* resolveStoredCredential(location, options);
  if (Option.isSome(credential)) {
    yield* hostProcess.setEnv(
      ROUTEKIT_EVAL_BEARER_TOKEN_ENV,
      credential.value.credentials.key
    );
    resolvedGatewayCredentialAtStartup = {
      source: credential.value.source,
      value: credential.value.credentials.key,
    };
    return Option.some(credential.value.source);
  }
  if (options.overrideExistingEnv === true) {
    return Option.none<GatewayAuthSource>();
  }
  if (Option.isSome(existingSource)) {
    const value = (yield* hostProcess.env)[ROUTEKIT_EVAL_BEARER_TOKEN_ENV];
    if (value !== undefined) {
      resolvedGatewayCredentialAtStartup = {
        source: existingSource.value,
        value,
      };
    }
  }
  return existingSource;
});
export const loadStoredGatewayKeyIntoEnvFrom = (
  location: LoadCredentialsLocation,
  options?: LoadStoredGatewayKeyOptions
): Effect.Effect<
  Option.Option<GatewayAuthSource>,
  never,
  | FileSystem.FileSystem
  | HostProcess
  | RouteKitEvalDirectory
  | Path.Path
  | RuntimeSecretStore
> =>
  loadStoredGatewayKeyIntoEnvFromEffect({
    location,
    options: options ?? { includeGlobal: true },
  }).pipe(Effect.orElseSucceed(() => Option.none<GatewayAuthSource>()));
export const loadStoredGatewayKeyIntoEnv = Effect.fn(
  "LoginCredentials.loadIntoEnv"
)(function* () {
  const hostProcess = yield* HostProcess;
  yield* loadStoredGatewayKeyIntoEnvFrom({
    startDir: yield* hostProcess.currentWorkingDirectory,
  });
});
export {
  globalAuthPath,
  localAuthPath,
  localRunCredentialPath,
  globalCredentialFallbackPath,
  readAuthCredentials,
  resetAmbientGatewayKeyForTest,
  writeAuthCredentials,
  hasGatewayKeyInEnv,
  hasResolvableGatewayCredential,
  captureAmbientGatewayKey,
  hasAmbientGatewayKey,
  projectGatewayAuthSourceAtStartup,
  restoreDotenvGatewayCredentialAtStartup,
  environmentGatewayAuthSource,
};
export type {
  AuthCredentials,
  LoadCredentialsLocation,
  LoadStoredGatewayKeyOptions,
  WriteAuthCredentialsInput,
};
