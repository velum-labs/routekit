import type { PlatformError, Scope } from "effect";

import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { encodeJsonString } from "../../../../contracts/internal/src/json.ts";
import { DEFAULT_DAEMON_HOST } from "../daemon/core/http-defaults.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const DEV_DESCRIPTOR_RELATIVE_PATH = ".routekit-eval/dev.json";

const DESCRIPTOR_TMP_SUFFIX = ".tmp";

const FEATURES_DIR = "features";

const JSON_INDENT = 2;

interface DevDescriptorDiscovery {
  readonly descriptor: DevDescriptor | null;
  readonly workspaceRoot: string | null;
}

interface LocalRuntimeEndpoint {
  readonly featuresRoot: string | null;
  readonly host: string;
  readonly port: number;
  readonly workspaceRoot: string | null;
}

interface ResolveLocalRuntimeEndpointInput {
  readonly host: Option.Option<string>;
  readonly port: Option.Option<number>;
  readonly startDir: string;
  /**
   * Workspace root to attach to when no descriptor is found in the cwd tree —
   * the global workspace (`~/.routekit-eval/global`) so `routekit-eval tui`/`routekit-eval logs`/etc. can
   * reach a globally-running daemon from any directory.
   */
  readonly fallbackWorkspaceRoot?: string;
}

interface AcquireDevDescriptorInput {
  readonly featuresRoot: string;
  readonly host: string;
  readonly name: string;
  readonly port: number;
  readonly workspaceRoot: string;
}

const DevDescriptorSchema = Schema.Struct({
  featuresRoot: Schema.String,
  host: Schema.String,
  name: Schema.String,
  port: Schema.Number,
  workspaceRoot: Schema.String,
});

type DevDescriptor = typeof DevDescriptorSchema.Type;

const decodeDevDescriptorJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DevDescriptorSchema),
  {
    onExcessProperty: "error",
  }
);

const workspaceRootFromFeaturesRoot = (
  path: Path.Path,
  resolvedFeaturesRoot: string
): string => path.dirname(resolvedFeaturesRoot);

const devDescriptorPath = (path: Path.Path, workspaceRoot: string): string =>
  path.join(workspaceRoot, DEV_DESCRIPTOR_RELATIVE_PATH);

const writeDevDescriptor = Effect.fn("DevDescriptor.write")(function* (
  workspaceRoot: string,
  descriptor: DevDescriptor
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const descriptorPath = devDescriptorPath(path, workspaceRoot);
  yield* fs.makeDirectory(path.dirname(descriptorPath), {
    recursive: true,
  });
  const tmpPath = `${descriptorPath}${DESCRIPTOR_TMP_SUFFIX}`;
  const serialized = yield* encodeJsonString(
    DevDescriptorSchema,
    JSON_INDENT
  )(descriptor);
  yield* fs.writeFileString(tmpPath, `${serialized}\n`);
  yield* fs.rename(tmpPath, descriptorPath);
});

const removeDevDescriptor = Effect.fn("DevDescriptor.remove")(function* (
  workspaceRoot: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const descriptorPath = devDescriptorPath(path, workspaceRoot);
  const exists = yield* fs
    .exists(descriptorPath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return;
  }

  yield* fs
    .remove(descriptorPath, {
      recursive: false,
    })
    .pipe(Effect.ignore);
});

const readDevDescriptor = Effect.fn("DevDescriptor.read")(function* (
  descriptorPath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(descriptorPath);
  return yield* decodeDevDescriptorJson(contents).pipe(
    Effect.mapError(
      (cause) =>
        new CliFailureError({
          detail: `Invalid ${DEV_DESCRIPTOR_RELATIVE_PATH}: ${formatUnknownError(cause)}`,
        })
    )
  );
});

const readFallbackDevDescriptor = Effect.fn("DevDescriptor.readFallback")(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    fallbackWorkspaceRoot: string | undefined
  ) {
    if (fallbackWorkspaceRoot === undefined) {
      return null;
    }
    const descriptorPath = devDescriptorPath(path, fallbackWorkspaceRoot);
    const exists = yield* fs
      .exists(descriptorPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return null;
    }
    return yield* readDevDescriptor(descriptorPath);
  }
);

const removeDevDescriptorIfOwned = Effect.fn("DevDescriptor.removeIfOwned")(
  function* (workspaceRoot: string, expectedPort: number) {
    const path = yield* Path.Path;
    const descriptorPath = devDescriptorPath(path, workspaceRoot);
    const current = yield* readDevDescriptor(descriptorPath).pipe(
      Effect.option
    );
    if (Option.isSome(current) && current.value.port === expectedPort) {
      yield* removeDevDescriptor(workspaceRoot);
    }
  }
);

const acquireDevDescriptor = (
  input: AcquireDevDescriptorInput
): Effect.Effect<
  void,
  PlatformError.PlatformError | Schema.SchemaError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.acquireRelease(
    writeDevDescriptor(input.workspaceRoot, {
      featuresRoot: input.featuresRoot,
      host: input.host,
      name: input.name,
      port: input.port,
      workspaceRoot: input.workspaceRoot,
    }),
    () =>
      removeDevDescriptorIfOwned(input.workspaceRoot, input.port).pipe(
        Effect.ignore
      )
  );

const isDirectory = (
  fs: FileSystem.FileSystem,
  targetPath: string
): Effect.Effect<boolean> =>
  fs.exists(targetPath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fs.stat(targetPath).pipe(
            Effect.map((stat) => stat.type === "Directory"),
            Effect.orElseSucceed(() => false)
          )
        : Effect.succeed(false)
    ),
    Effect.orElseSucceed(() => false)
  );

const findWorkspaceRootFromCwd = Effect.fn("DevDescriptor.findWorkspaceRoot")(
  function* (fs: FileSystem.FileSystem, path: Path.Path, startDir: string) {
    let dir = path.resolve(startDir);

    for (;;) {
      const featuresPath = path.join(dir, FEATURES_DIR);
      const hasFeatures = yield* isDirectory(fs, featuresPath);
      if (hasFeatures) {
        return dir;
      }

      const parent = path.dirname(dir);
      if (parent === dir) {
        return null;
      }
      dir = parent;
    }
  }
);

const discoverDevDescriptor = Effect.fn("DevDescriptor.discover")(function* (
  startDir: string,
  fallbackWorkspaceRoot?: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = yield* findWorkspaceRootFromCwd(fs, path, startDir);
  let dir = path.resolve(startDir);

  for (;;) {
    const descriptorPath = devDescriptorPath(path, dir);
    const exists = yield* fs
      .exists(descriptorPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      const descriptor = yield* readDevDescriptor(descriptorPath);
      return {
        descriptor,
        workspaceRoot,
      } satisfies DevDescriptorDiscovery;
    }

    if (workspaceRoot !== null && dir === workspaceRoot) {
      break;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  // No descriptor in the cwd tree. When a fallback workspace (the global
  // `~/.routekit-eval/global`) is provided, attach to its running daemon so companion
  // commands work from any directory.
  const fallbackDescriptor = yield* readFallbackDevDescriptor(
    fs,
    path,
    fallbackWorkspaceRoot
  );
  if (fallbackDescriptor !== null) {
    return {
      descriptor: fallbackDescriptor,
      workspaceRoot: fallbackWorkspaceRoot ?? workspaceRoot,
    } satisfies DevDescriptorDiscovery;
  }

  return {
    descriptor: null,
    workspaceRoot,
  } satisfies DevDescriptorDiscovery;
});

/**
 * Descriptor lookup shared by both explicit-port branches below, so `routekit-eval tui
 * --host H --port P` (as launched by `routekit-eval code`) inherits the daemon's real
 * `featuresRoot`/`workspaceRoot` instead of falling back to `${cwd}/features`.
 * Only adopted when the descriptor's `port` matches `explicitPort` — the same
 * discriminator `removeDevDescriptorIfOwned` uses — so an unrelated local
 * `.routekit-eval/dev.json` (a different `routekit-eval dev` session, or the fallback global
 * workspace) can't leak into a connection aimed at a different daemon.
 */
const discoverExplicitEndpointDescriptor = (
  input: ResolveLocalRuntimeEndpointInput,
  explicitPort: number
): Effect.Effect<
  DevDescriptor | null,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  discoverDevDescriptor(input.startDir).pipe(
    Effect.map((discovery) =>
      discovery.descriptor?.port === explicitPort ? discovery.descriptor : null
    ),
    Effect.orElseSucceed(() => null)
  );

/**
 * Endpoint resolution when host and/or port are supplied explicitly (see
 * {@link discoverExplicitEndpointDescriptor}). Returns `null` when neither
 * host nor port is given (only port-less, host-less invocations fall through
 * to full discovery).
 */
const resolveExplicitEndpoint = Effect.fn(
  "DevDescriptor.resolveExplicitEndpoint"
)(function* (
  input: ResolveLocalRuntimeEndpointInput
): Effect.fn.Return<
  LocalRuntimeEndpoint | null,
  never,
  FileSystem.FileSystem | Path.Path
> {
  if (Option.isSome(input.host) && Option.isSome(input.port)) {
    const descriptor = yield* discoverExplicitEndpointDescriptor(
      input,
      input.port.value
    );
    return {
      featuresRoot: descriptor?.featuresRoot ?? null,
      host: input.host.value,
      port: input.port.value,
      workspaceRoot: descriptor?.workspaceRoot ?? null,
    } satisfies LocalRuntimeEndpoint;
  }

  if (Option.isSome(input.port)) {
    const descriptor = yield* discoverExplicitEndpointDescriptor(
      input,
      input.port.value
    );
    return {
      featuresRoot: descriptor?.featuresRoot ?? null,
      host: Option.isSome(input.host) ? input.host.value : DEFAULT_DAEMON_HOST,
      port: input.port.value,
      workspaceRoot: descriptor?.workspaceRoot ?? null,
    } satisfies LocalRuntimeEndpoint;
  }

  return null;
});

/** Endpoint resolution from a discovered descriptor (the no-explicit-port path). */
const resolveDiscoveredEndpoint = Effect.fn(
  "DevDescriptor.resolveDiscoveredEndpoint"
)(function* (
  path: Path.Path,
  input: ResolveLocalRuntimeEndpointInput,
  discovery: DevDescriptorDiscovery
): Effect.fn.Return<LocalRuntimeEndpoint, CliFailureError> {
  if (Option.isNone(input.host)) {
    if (discovery.descriptor === null) {
      const searchedRoot =
        discovery.workspaceRoot ?? path.resolve(input.startDir);
      return yield* new CliFailureError({
        detail: `No local RouteKitEval dev runtime found at ${devDescriptorPath(path, searchedRoot)}. Start \`routekit-eval dev\` or pass --host and/or --port.`,
      });
    }

    return {
      featuresRoot: discovery.descriptor.featuresRoot,
      host: discovery.descriptor.host,
      port: discovery.descriptor.port,
      workspaceRoot: discovery.descriptor.workspaceRoot,
    };
  }

  if (discovery.descriptor === null) {
    return yield* new CliFailureError({
      detail:
        "No local RouteKitEval dev runtime port found. Start `routekit-eval dev` or pass --port.",
    });
  }

  return {
    featuresRoot: discovery.descriptor.featuresRoot,
    host: input.host.value,
    port: discovery.descriptor.port,
    workspaceRoot: discovery.descriptor.workspaceRoot,
  };
});

export const resolveLocalRuntimeEndpoint = Effect.fn(
  "DevDescriptor.resolveEndpoint"
)(function* (input: ResolveLocalRuntimeEndpointInput) {
  const path = yield* Path.Path;

  const explicit = yield* resolveExplicitEndpoint(input);
  if (explicit !== null) {
    return explicit;
  }

  const discovery = yield* discoverDevDescriptor(
    input.startDir,
    input.fallbackWorkspaceRoot
  );
  return yield* resolveDiscoveredEndpoint(path, input, discovery);
});

export {
  DEV_DESCRIPTOR_RELATIVE_PATH,
  workspaceRootFromFeaturesRoot,
  devDescriptorPath,
  writeDevDescriptor,
  removeDevDescriptor,
  readDevDescriptor,
  acquireDevDescriptor,
  findWorkspaceRootFromCwd,
  discoverDevDescriptor,
};
export type {
  DevDescriptor,
  DevDescriptorDiscovery,
  LocalRuntimeEndpoint,
  ResolveLocalRuntimeEndpointInput,
  AcquireDevDescriptorInput,
};
