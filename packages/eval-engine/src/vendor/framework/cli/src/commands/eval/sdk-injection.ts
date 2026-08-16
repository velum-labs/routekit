import type { PlatformError } from "effect";

import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Exit, FileSystem, Option, Schema } from "effect";

const SDK_PACKAGE_NAME = "routekit";
const SDK_SPECIFIER = "routekit/eval";
const COMPAT_PACKAGE_NAME = "ori";
const COMPAT_SPECIFIER = "ori/eval";
const SDK_PACKAGE_NAMES = [SDK_PACKAGE_NAME, COMPAT_PACKAGE_NAME] as const;

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const EVAL_SDK_ARTIFACTS = [
  // Direct source execution in tests and development.
  join(
    MODULE_DIRECTORY,
    "..",
    "init",
    "author-contracts-artifacts",
    "eval.js.txt"
  ),
  // The private qualification executable is bundled into `dist/`.
  join(
    MODULE_DIRECTORY,
    "..",
    "src",
    "vendor",
    "framework",
    "cli",
    "src",
    "commands",
    "init",
    "author-contracts-artifacts",
    "eval.js.txt"
  )
] as const;

export const ROUTEKIT_EVAL_RUNTIME_ORIGIN_ENV =
  "ROUTEKIT_EVAL_RUNTIME_ORIGIN";
export const ROUTEKIT_EVAL_COMPARISON_ID_ENV =
  "ROUTEKIT_EVAL_COMPARISON_ID";

const encodeJson = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const resolveFromSearchRoot = (
  searchRoot: string,
  specifier: string
): boolean =>
  Option.isSome(
    Option.liftThrowable(() =>
      createRequire(join(searchRoot, "package.json")).resolve(specifier)
    )()
  );

const sdkPackageJson = (name: string): string =>
  `${encodeJson({
    exports: {
      "./eval": "./eval.js"
    },
    name,
    private: true,
    type: "module",
    version: "0.0.0"
  })}\n`;

export type MaterializedEvalSdk =
  | {
      readonly kind: "owned";
      readonly directory: string;
      readonly linkPaths?: readonly string[];
    }
  | {
      readonly kind: "borrowed";
    };

export interface MaterializeEvalSdkOptions {
  readonly directory?: string;
}

/** Drop `NODE_TEST_CONTEXT` so a nested `node --test` is a real run. */
const evalNodeTestEnv = (
  env: Record<string, string | undefined>
): Record<string, string | undefined> => {
  const { NODE_TEST_CONTEXT: _nestedTest, ...rest } = env;
  return rest;
};

/**
 * Make the generated `routekit/eval` package visible to the eval child, plus an
 * `ori/eval` alias so Ori-authored suites resolve. ESM uses the workspace
 * symlink; `NODE_PATH` also supports CommonJS tooling from the temp root.
 */
export const applyEvalSdkEnv = (
  env: Record<string, string | undefined>,
  sdk: MaterializedEvalSdk | undefined,
  pathDelimiter: string = delimiter
): Record<string, string | undefined> => {
  const childEnv = evalNodeTestEnv(env);
  if (sdk?.kind !== "owned") {
    return childEnv;
  }
  const existing = childEnv.NODE_PATH;
  return {
    ...childEnv,
    NODE_PATH:
      existing === undefined || existing === ""
        ? sdk.directory
        : `${sdk.directory}${pathDelimiter}${existing}`
  };
};

const linkOwnedSdk = Effect.fn("EvalCommand.linkOwnedSdk")(function* (
  searchRoot: string,
  packageName: string,
  packageDirectory: string
) {
  const fs = yield* FileSystem.FileSystem;
  const nodeModules = join(searchRoot, "node_modules");
  const linkPath = join(nodeModules, packageName);
  return yield* fs.makeDirectory(nodeModules, { recursive: true }).pipe(
    Effect.andThen(fs.symlink(packageDirectory, linkPath)),
    Effect.as(linkPath),
    Effect.option
  );
});

const readEvalSdkArtifact = Effect.fn("EvalCommand.readEvalSdkArtifact")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.firstSuccessOf(
      EVAL_SDK_ARTIFACTS.map((artifact) => fs.readFileString(artifact))
    );
  }
);

/** Materialize `routekit/eval` and the `ori/eval` alias Ori-authored suites use. */
export const materializeEvalSdk = Effect.fn("EvalCommand.materializeEvalSdk")(
  function* (
    searchRoot: string,
    options: MaterializeEvalSdkOptions = {}
  ): Effect.fn.Return<
    MaterializedEvalSdk | undefined,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    if (
      options.directory === undefined &&
      resolveFromSearchRoot(searchRoot, SDK_SPECIFIER) &&
      resolveFromSearchRoot(searchRoot, COMPAT_SPECIFIER)
    ) {
      return undefined;
    }
    const fs = yield* FileSystem.FileSystem;
    const directory =
      options.directory ??
      (yield* fs.makeTempDirectory({
        prefix: "routekit-eval-sdk-"
      }));
    const ownsDirectory = options.directory === undefined;
    return yield* Effect.gen(function* () {
      const artifact = yield* readEvalSdkArtifact();
      const packageDirectories = Object.fromEntries(
        SDK_PACKAGE_NAMES.map((packageName) => [
          packageName,
          ownsDirectory
            ? join(directory, "node_modules", packageName)
            : join(directory, packageName)
        ])
      ) as Record<(typeof SDK_PACKAGE_NAMES)[number], string>;
      for (const packageName of SDK_PACKAGE_NAMES) {
        const packageDirectory = packageDirectories[packageName];
        yield* fs.makeDirectory(packageDirectory, { recursive: true });
        yield* fs.writeFileString(join(packageDirectory, "eval.js"), artifact);
        yield* fs.writeFileString(
          join(packageDirectory, "package.json"),
          sdkPackageJson(packageName)
        );
      }
      if (!ownsDirectory) {
        return { kind: "borrowed" as const };
      }
      const linkPaths: string[] = [];
      for (const packageName of SDK_PACKAGE_NAMES) {
        const linkPath = yield* linkOwnedSdk(
          searchRoot,
          packageName,
          packageDirectories[packageName]
        );
        if (Option.isSome(linkPath)) {
          linkPaths.push(linkPath.value);
        }
      }
      return {
        kind: "owned" as const,
        directory,
        ...(linkPaths.length > 0 ? { linkPaths } : {})
      };
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) || !ownsDirectory
          ? Effect.void
          : fs.remove(directory, { recursive: true }).pipe(Effect.ignore)
      )
    );
  }
);
