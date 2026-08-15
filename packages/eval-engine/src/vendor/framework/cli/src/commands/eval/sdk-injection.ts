import type { PlatformError } from "effect";

import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Exit, FileSystem, Option, Schema } from "effect";

const SDK_PACKAGE_NAME = "routekit";
const SDK_SPECIFIER = "routekit/eval";

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

const sdkPackageJson = (): string =>
  `${encodeJson({
    exports: {
      "./eval": "./eval.js"
    },
    name: SDK_PACKAGE_NAME,
    private: true,
    type: "module",
    version: "0.0.0"
  })}\n`;

export type MaterializedEvalSdk =
  | {
      readonly kind: "owned";
      readonly directory: string;
      readonly linkPath?: string;
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
 * Make the private generated `routekit/eval` package visible to the eval child.
 * ESM resolution uses the scoped workspace symlink; `NODE_PATH` also supports
 * CommonJS tooling that resolves from the temporary package root.
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
  packageDirectory: string
) {
  const fs = yield* FileSystem.FileSystem;
  const nodeModules = join(searchRoot, "node_modules");
  const linkPath = join(nodeModules, SDK_PACKAGE_NAME);
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

/** Materialize only the public authoring surface, `routekit/eval`. */
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
      resolveFromSearchRoot(searchRoot, SDK_SPECIFIER)
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
      const packageDirectory = ownsDirectory
        ? join(directory, "node_modules", SDK_PACKAGE_NAME)
        : join(directory, SDK_PACKAGE_NAME);
      yield* fs.makeDirectory(packageDirectory, { recursive: true });
      yield* fs.writeFileString(
        join(packageDirectory, "eval.js"),
        yield* readEvalSdkArtifact()
      );
      yield* fs.writeFileString(
        join(packageDirectory, "package.json"),
        sdkPackageJson()
      );
      if (!ownsDirectory) {
        return { kind: "borrowed" as const };
      }
      const linkPath = yield* linkOwnedSdk(searchRoot, packageDirectory);
      return {
        kind: "owned" as const,
        directory,
        ...(Option.isSome(linkPath) ? { linkPath: linkPath.value } : {})
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
