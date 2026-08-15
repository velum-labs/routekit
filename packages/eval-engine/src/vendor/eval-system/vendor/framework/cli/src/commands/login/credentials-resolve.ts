import type { Path } from "effect";

import { Effect, FileSystem, Option, Schema } from "effect";

import type { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import type { GatewayAuthSource } from "../../../../contracts/internal/src/gateway-auth.ts";

import { makeCliFailureFromCause } from "../../../../contracts/internal/src/errors.ts";
import {
  RouteKitEvalDirectory,
  resolveGlobalAuthPath,
  resolveGlobalCredentialFallbackPath,
} from "../../routekit-eval-directory.ts";

const AuthCredentialsSchema = Schema.Struct({
  createdAt: Schema.String,
  key: Schema.String,
  userId: Schema.NullOr(Schema.String),
});

type AuthCredentials = typeof AuthCredentialsSchema.Type;

const decodeAuthCredentialsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AuthCredentialsSchema),
  {
    onExcessProperty: "error",
  }
);

interface LoadCredentialsLocation {
  readonly startDir: string;
}

interface StoredCredentialResolutionOptions {
  readonly includeGlobal: boolean;
  /**
   * When true, the workspace-local run credential `.routekit-eval/start.json` is preferred
   * over `.routekit-eval/credentials.json` if it exists (used by `routekit-eval start`, RFC 0004
   * start.md). Defaults to false so `routekit-eval dev` keeps reading `credentials.json`.
   */
  readonly preferRunCredential?: boolean;
  readonly workspaceRoot?: string;
}

interface StoredGatewayCredential {
  readonly credentials: AuthCredentials;
  readonly source: GatewayAuthSource;
}

const DEFAULT_STORED_CREDENTIAL_RESOLUTION_OPTIONS = {
  includeGlobal: true,
} satisfies StoredCredentialResolutionOptions;

const globalAuthPath = Effect.fn("LoginCredentials.globalAuthPath")(function* (
  homeDir: string
) {
  const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
  return routeKitEvalDirectory.globalAuthPath(homeDir);
});

const localAuthPath = Effect.fn("LoginCredentials.localAuthPath")(function* (
  workspaceRoot: string
) {
  const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
  return routeKitEvalDirectory.localAuthPath(workspaceRoot);
});

const localRunCredentialPath = Effect.fn(
  "LoginCredentials.localRunCredentialPath"
)(function* (workspaceRoot: string) {
  const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
  return routeKitEvalDirectory.localRunCredentialPath(workspaceRoot);
});

const globalCredentialFallbackPath = Effect.fn(
  "LoginCredentials.globalCredentialFallbackPath"
)(function* (homeDir: string) {
  const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
  return routeKitEvalDirectory.globalCredentialFallbackPath(homeDir);
});

const readAuthCredentials = Effect.fn("LoginCredentials.read")(function* (
  filePath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs
    .readFileString(filePath)
    .pipe(
      Effect.mapError(makeCliFailureFromCause(`Failed to read ${filePath}`))
    );
  return yield* decodeAuthCredentialsJson(contents).pipe(
    Effect.mapError(
      makeCliFailureFromCause(`Invalid credentials in ${filePath}`)
    )
  );
});

/**
 * Build the ordered list of credential file candidates to probe: workspace-local
 * (run credential first when `preferRunCredential`, then `credentials.json`)
 * before the global locations. Resolution order here is load-bearing.
 */
const resolveCredentialCandidatePaths = Effect.fn(
  "LoginCredentials.candidatePaths"
)(function* (input: {
  readonly location: LoadCredentialsLocation;
  readonly options: StoredCredentialResolutionOptions;
}) {
  const { location, options } = input;
  const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
  const localRoot =
    options.workspaceRoot === undefined
      ? yield* routeKitEvalDirectory.workspaceRootFrom(location.startDir)
      : Option.some(options.workspaceRoot);
  return [
    ...(Option.isSome(localRoot)
      ? [
          ...(options.preferRunCredential === true
            ? [
                {
                  kind: "workspace" as const,
                  path: routeKitEvalDirectory.localRunCredentialPath(localRoot.value),
                },
              ]
            : []),
          {
            kind: "workspace" as const,
            path: routeKitEvalDirectory.localAuthPath(localRoot.value),
          },
        ]
      : []),
    ...(options.includeGlobal
      ? [
          {
            kind: "global" as const,
            path: yield* resolveGlobalAuthPath(),
          },
          {
            kind: "global" as const,
            path: yield* resolveGlobalCredentialFallbackPath(),
          },
        ]
      : []),
  ];
});

const resolveStoredCredentialEffect = Effect.fn(
  "LoginCredentials.resolveStored"
)(function* (input: {
  readonly location: LoadCredentialsLocation;
  readonly options: StoredCredentialResolutionOptions;
}) {
  const { location, options } = input;
  const fs = yield* FileSystem.FileSystem;
  const candidatePaths = yield* resolveCredentialCandidatePaths({
    location,
    options,
  });

  for (const candidate of candidatePaths) {
    const exists = yield* fs
      .exists(candidate.path)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      continue;
    }
    const credentials = yield* readAuthCredentials(candidate.path).pipe(
      Effect.option
    );
    if (Option.isSome(credentials)) {
      return Option.some({
        credentials: credentials.value,
        source: {
          kind: candidate.kind,
          location: candidate.path,
        },
      });
    }
  }

  return Option.none<StoredGatewayCredential>();
});

const resolveStoredCredential = (
  location: LoadCredentialsLocation,
  options: StoredCredentialResolutionOptions = DEFAULT_STORED_CREDENTIAL_RESOLUTION_OPTIONS
): Effect.Effect<
  Option.Option<StoredGatewayCredential>,
  never,
  FileSystem.FileSystem | HostProcess | RouteKitEvalDirectory | Path.Path
> =>
  resolveStoredCredentialEffect({
    location,
    options,
  }).pipe(
    Effect.orElseSucceed(() => Option.none<StoredGatewayCredential>())
  );

export {
  AuthCredentialsSchema,
  globalAuthPath,
  globalCredentialFallbackPath,
  localAuthPath,
  localRunCredentialPath,
  readAuthCredentials,
  resolveStoredCredential,
};
export type {
  AuthCredentials,
  LoadCredentialsLocation,
  StoredCredentialResolutionOptions,
  StoredGatewayCredential,
};
