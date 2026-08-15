import type { PlatformError } from "effect";

import { createRequire } from "node:module";
import { delimiter, join } from "node:path";

import { Effect, Exit, FileSystem, Option, Schema } from "effect";

import {
  authorContractsEvalJavascript,
  authorContractsJavascript,
  authorContractsTestJavascript,
} from "../init/author-contracts.ts";

const SDK_PACKAGE_NAME = "ori";

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
      ".": "./index.js",
      "./eval": "./eval.js",
      "./test": "./test.js",
    },
    name: SDK_PACKAGE_NAME,
    private: true,
    type: "module",
    version: "0.0.0",
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

/**
 * Drop `NODE_TEST_CONTEXT` so a nested `node --test` is a real run.
 *
 * Production tests (and any caller already inside `node --test`) spawn this CLI
 * with that variable set. The eval child is also `node --test`; if it inherits
 * the variable, Node warns that `run()` is recursive and skips every file —
 * dry-run fail-closes, and a full run exits 0 with an empty JUnit file.
 */
const evalNodeTestEnv = (
  env: Record<string, string | undefined>
): Record<string, string | undefined> => {
  const { NODE_TEST_CONTEXT: _nestedTest, ...rest } = env;
  return rest;
};

/**
 * NODE_PATH points at the temp root so `<temp>/node_modules/ori` is visible to
 * CJS resolution. ESM ignores NODE_PATH, so {@link materializeEvalSdk} also
 * symlinks `cwd/node_modules/ori` at the same package.
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
        : `${sdk.directory}${pathDelimiter}${existing}`,
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

export const materializeEvalSdk = Effect.fn("EvalCommand.materializeEvalSdk")(
  function* (
    searchRoot: string,
    options: MaterializeEvalSdkOptions = {}
  ): Effect.fn.Return<
    MaterializedEvalSdk | undefined,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    const bundled = Object.entries({
      [SDK_PACKAGE_NAME]: authorContractsJavascript,
      [`${SDK_PACKAGE_NAME}/eval`]: authorContractsEvalJavascript,
      [`${SDK_PACKAGE_NAME}/test`]: authorContractsTestJavascript,
    });
    const missing =
      options.directory === undefined
        ? bundled.filter(
            ([specifier]) => !resolveFromSearchRoot(searchRoot, specifier)
          )
        : bundled;
    if (missing.length === 0) {
      return undefined;
    }
    const fs = yield* FileSystem.FileSystem;
    const directory =
      options.directory ??
      (yield* fs.makeTempDirectory({
        prefix: "ori-eval-sdk-",
      }));
    const ownsDirectory = options.directory === undefined;
    return yield* Effect.gen(function* () {
      const packageDirectory = ownsDirectory
        ? join(directory, "node_modules", SDK_PACKAGE_NAME)
        : join(directory, SDK_PACKAGE_NAME);
      yield* fs.makeDirectory(packageDirectory, { recursive: true });
      for (const [specifier, javascript] of bundled) {
        const subpath = specifier.slice(`${SDK_PACKAGE_NAME}/`.length);
        const filename =
          specifier === SDK_PACKAGE_NAME ? "index.js" : `${subpath}.js`;
        yield* fs.writeFileString(join(packageDirectory, filename), javascript);
      }
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
        ...(Option.isSome(linkPath) ? { linkPath: linkPath.value } : {}),
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
