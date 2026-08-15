import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import {
  isPackedInternEnv,
  readPackedInternLauncherEnv,
} from "../../../../contracts/internal/src/cli/intern-launcher-env.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { decodeJsonString } from "../../../../contracts/internal/src/json.ts";
import { workspaceRootFromFeaturesRoot } from "../../../../runloop/local/src/dev/descriptor.ts";
import { isCompiledCliBuild } from "../../build-info.ts";
import { OriCliExit } from "../../cli-exit.ts";
import { mtimeMs } from "./fs-mtime.ts";
import { writeProgressNotice } from "./progress-notice.ts";
import { oriChildArgvFrom } from "./split/child-argv.ts";

const LOCK_FILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;
const NODE_MODULES = "node_modules";
const PACKAGE_JSON = "package.json";
const SUCCESS_EXIT_CODE = 0;
const INSTALL_ARGS = [
  "install",
  "--ignore-scripts",
  "--no-fund",
  "--no-audit",
] as const;
const ORI_DEV_DEPENDENCY_INSTALL_RESTARTED_ENV =
  "ORI_DEV_DEPENDENCY_INSTALL_RESTARTED";

type DevDependencyInstallReason =
  | "manifestNewerThanLockfile"
  | "missingDependency"
  | "missingLockfile"
  | "missingNodeModules";

type DevDependencyInstallDecision =
  | {
      readonly kind: "install";
      readonly reason: DevDependencyInstallReason;
      readonly workspaceRoot: string;
    }
  | {
      readonly kind: "skip";
      readonly reason: "current" | "disabled" | "noPackageJson" | "packed";
      readonly workspaceRoot: string;
    };

const shouldRestartAfterDevDependencyInstall = (
  decision: DevDependencyInstallDecision,
  env: Readonly<Record<string, string | undefined>>
): boolean =>
  decision.kind === "install" &&
  env[ORI_DEV_DEPENDENCY_INSTALL_RESTARTED_ENV] !== "1";

// Node lays out `process.argv` with the runtime at [0] and the entry script at
// [1], so user args always start at [2]. `oriChildArgvFrom` rebuilds the child
// argv from execPath + main, so we only pass the passthrough tail here.
const PASSTHROUGH_ARGV_START = 2;

const devDependencyRestartArgvFrom = (input: {
  readonly execPath: string;
  readonly main: string;
  readonly processArgv: readonly string[];
}): readonly string[] => {
  const passthroughArgs = input.processArgv.slice(PASSTHROUGH_ARGV_START);
  return oriChildArgvFrom(
    {
      execPath: input.execPath,
      main: input.main,
    },
    passthroughArgs
  );
};

const currentDevDependencyRestartArgv = (): readonly string[] =>
  devDependencyRestartArgvFrom({
    execPath: process.execPath,
    main: process.argv[1] ?? process.execPath,
    processArgv: process.argv,
  });

const restartAfterDevDependencyInstall = Effect.fn("DevDependencies.restart")(
  function* (decision: DevDependencyInstallDecision) {
    const hostProcess = yield* HostProcess;
    const env = yield* hostProcess.env;
    if (!shouldRestartAfterDevDependencyInstall(decision, env)) {
      return false;
    }

    const argv = currentDevDependencyRestartArgv();
    yield* Effect.logDebug("ori dev dependency-install restart", {
      argv,
      execPath: process.execPath,
      isCompiledCliBuild: isCompiledCliBuild(),
      main: process.argv[1] ?? process.execPath,
    });
    if (argv.length === 0) {
      return yield* new CliFailureError({
        detail:
          "Could not restart ori dev after installing dependencies: no current executable was available.",
      });
    }
    const [command, ...args] = argv;

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* writeProgressNotice(
      "Restarting ori dev after dependency install...\n"
    );
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, args, {
        env: {
          ...env,
          [ORI_DEV_DEPENDENCY_INSTALL_RESTARTED_ENV]: "1",
        },
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
      })
    );

    // The dependency-install re-exec waits for the replacement `ori dev` to run
    // to completion, then this (now-thin) parent must exit with the child's exact
    // code. Rather than a manual exit syscall, fail with the `OriCliExit` marker:
    // it carries `Runtime.errorExitCode`, so `runOriCli` surfaces the code and the
    // `runMain` teardown applies it — after Effect finalizers run.
    return yield* new OriCliExit({ exitCode: Number(exitCode) });
  }
);

const installDecision = (
  reason: DevDependencyInstallReason,
  workspaceRoot: string
): DevDependencyInstallDecision => ({
  kind: "install",
  reason,
  workspaceRoot,
});

const skipDecision = (
  reason: "current" | "disabled" | "noPackageJson" | "packed",
  workspaceRoot: string
): DevDependencyInstallDecision => ({
  kind: "skip",
  reason,
  workspaceRoot,
});

const DependencyMapSchema = Schema.Record(Schema.String, Schema.String);
const PackageJsonSchema = Schema.Struct({
  // Only runtime `dependencies` decide whether a reused workspace needs repair;
  // dev/peer deps are expected to vary, and optional deps may legitimately be absent.
  dependencies: Schema.optionalKey(DependencyMapSchema),
});

const packageDependencyNames = Effect.fn("DevDependencies.packageNames")(
  function* (packageJsonPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const packageJson = yield* fs
      .readFileString(packageJsonPath)
      .pipe(Effect.flatMap(decodeJsonString(PackageJsonSchema)), Effect.option);
    if (Option.isNone(packageJson)) {
      return [];
    }
    return Object.keys(packageJson.value.dependencies ?? {});
  }
);

const hasInstalledWorkspaceDependencies = Effect.fn(
  "DevDependencies.hasInstalledWorkspaceDependencies"
)(function* (featuresRoot: string, workspaceRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageJsonPaths = [path.join(workspaceRoot, PACKAGE_JSON)];
  const featureNames = yield* fs
    .readDirectory(featuresRoot)
    .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
  for (const featureName of featureNames) {
    packageJsonPaths.push(path.join(featuresRoot, featureName, PACKAGE_JSON));
  }

  const packageDependencies: {
    readonly packageRoot: string;
    readonly dependencies: readonly string[];
  }[] = [];
  for (const packageJsonPath of packageJsonPaths) {
    packageDependencies.push({
      dependencies: yield* packageDependencyNames(packageJsonPath),
      packageRoot: path.dirname(packageJsonPath),
    });
  }
  for (const { dependencies, packageRoot } of packageDependencies) {
    for (const dependency of dependencies) {
      const installedInPackage = yield* fs.exists(
        path.join(packageRoot, NODE_MODULES, dependency)
      );
      const installedAtWorkspaceRoot =
        packageRoot !== workspaceRoot &&
        (yield* fs.exists(path.join(workspaceRoot, NODE_MODULES, dependency)));
      if (!installedInPackage && !installedAtWorkspaceRoot) {
        return false;
      }
    }
  }
  return true;
});

const fileInfo = Effect.fn("DevDependencies.fileInfo")(function* (
  filePath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(filePath).pipe(Effect.option);
  return info.pipe(Option.filter((value) => value.type === "File"));
});

const newestManifestMtimeMs = Effect.fn("DevDependencies.manifestMtime")(
  function* (featuresRoot: string, rootPackageJson: FileSystem.File.Info) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let newest = mtimeMs(rootPackageJson);
    const featureNames = yield* fs
      .readDirectory(featuresRoot)
      .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
    for (const featureName of featureNames) {
      const manifest = yield* fileInfo(
        path.join(featuresRoot, featureName, PACKAGE_JSON)
      );
      if (Option.isSome(manifest)) {
        newest = Math.max(newest, mtimeMs(manifest.value));
      }
    }
    return newest;
  }
);

const newestExistingFileInfo = Effect.fn(
  "DevDependencies.newestExistingFileInfo"
)(function* (paths: readonly string[]) {
  let newest = Option.none<FileSystem.File.Info>();
  for (const candidate of paths) {
    const info = yield* fileInfo(candidate);
    if (
      Option.isSome(info) &&
      (Option.isNone(newest) || mtimeMs(info.value) > mtimeMs(newest.value))
    ) {
      newest = info;
    }
  }
  return newest;
});

const directoryInfo = Effect.fn("DevDependencies.directoryInfo")(function* (
  directoryPath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(directoryPath).pipe(Effect.option);
  return info.pipe(Option.filter((value) => value.type === "Directory"));
});

const resolveCurrentWorkspaceDecision = Effect.fn(
  "DevDependencies.resolveCurrent"
)(function* (
  featuresRoot: string,
  workspaceRoot: string,
  rootPackageJson: FileSystem.File.Info
) {
  const path = yield* Path.Path;
  if (
    !(yield* hasInstalledWorkspaceDependencies(featuresRoot, workspaceRoot))
  ) {
    return installDecision("missingDependency", workspaceRoot);
  }

  const lockfile = yield* newestExistingFileInfo(
    LOCK_FILES.map((filename) => path.join(workspaceRoot, filename))
  );
  if (Option.isNone(lockfile)) {
    return installDecision("missingLockfile", workspaceRoot);
  }

  const newestManifestMtime = yield* newestManifestMtimeMs(
    featuresRoot,
    rootPackageJson
  );
  return newestManifestMtime > mtimeMs(lockfile.value)
    ? installDecision("manifestNewerThanLockfile", workspaceRoot)
    : skipDecision("current", workspaceRoot);
});

export const resolveDevDependencyInstallDecision = Effect.fn(
  "DevDependencies.plan"
)(function* (input: {
  readonly featuresRoot: string;
  readonly install: boolean;
  /**
   * Overrides the anchor used for the workspace's own `package.json`,
   * `node_modules`, and lockfile. Composing several `--features` sources
   * (`ori start`) roots `featuresRoot` under `.ori/composed`, an internal
   * cache dir with no `package.json` of its own; without this override,
   * `dirname(featuresRoot)` would anchor there and skip the real workspace's
   * install entirely. Absent → `dirname(featuresRoot)` as before.
   */
  readonly workspaceRoot?: string;
}) {
  const path = yield* Path.Path;
  const workspaceRoot =
    input.workspaceRoot ??
    workspaceRootFromFeaturesRoot(path, input.featuresRoot);
  if (!input.install) {
    return skipDecision("disabled", workspaceRoot);
  }

  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  if (isPackedInternEnv(env)) {
    const launcherEnv = readPackedInternLauncherEnv(env);
    if (
      launcherEnv.featuresRoot === undefined ||
      path.resolve(launcherEnv.featuresRoot) ===
        path.resolve(input.featuresRoot)
    ) {
      return skipDecision("packed", workspaceRoot);
    }
  }

  const rootPackageJsonPath = path.join(workspaceRoot, PACKAGE_JSON);
  const rootPackageJson = yield* fileInfo(rootPackageJsonPath);
  if (Option.isNone(rootPackageJson)) {
    return skipDecision("noPackageJson", workspaceRoot);
  }

  const nodeModules = yield* directoryInfo(
    path.join(workspaceRoot, NODE_MODULES)
  );
  if (Option.isNone(nodeModules)) {
    return installDecision("missingNodeModules", workspaceRoot);
  }

  return yield* resolveCurrentWorkspaceDecision(
    input.featuresRoot,
    workspaceRoot,
    rootPackageJson.value
  );
});

export const ensureDevWorkspaceDependencies = Effect.fn(
  "DevDependencies.ensure"
)(function* (input: {
  readonly featuresRoot: string;
  readonly install: boolean;
  readonly workspaceRoot?: string;
}) {
  const decision = yield* resolveDevDependencyInstallDecision(input);
  if (decision.kind === "skip") {
    return decision;
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* writeProgressNotice(
    `Installing dependencies in ${decision.workspaceRoot}...\n`
  );
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make("npm", INSTALL_ARGS, {
      cwd: decision.workspaceRoot,
      stderr: "inherit",
      stdout: "ignore",
    })
  );
  if (Number(exitCode) !== SUCCESS_EXIT_CODE) {
    return yield* new CliFailureError({
      detail: `Could not install intern dependencies in ${decision.workspaceRoot}: npm ${INSTALL_ARGS.join(
        " "
      )} exited with code ${Number(exitCode)}. Run \`cd ${decision.workspaceRoot} && npm install --ignore-scripts\`, then \`ori dev\`.`,
    });
  }

  return decision;
});

export {
  ORI_DEV_DEPENDENCY_INSTALL_RESTARTED_ENV,
  shouldRestartAfterDevDependencyInstall,
  devDependencyRestartArgvFrom,
  restartAfterDevDependencyInstall,
};
export type { DevDependencyInstallReason, DevDependencyInstallDecision };
