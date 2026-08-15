import type { PlatformError } from "effect";

import { Effect, FileSystem, Option, Path, Schema } from "effect";

import {
  AUTHOR_CONTRACTS_PACKAGE,
  AUTHOR_CONTRACTS_PACKAGE_VERSION,
  EFFECT_PACKAGE,
  EFFECT_PACKAGE_VERSION,
  PLATFORM_BUN_PACKAGE,
  PLATFORM_BUN_PACKAGE_VERSION,
  SLACK_TYPES_PACKAGE,
  SLACK_TYPES_PACKAGE_VERSION,
} from "../author-contracts-package.ts";
import { OriDirectory } from "../../ori-directory.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

import authorContractsConfigTypescript from "./author-contracts-artifacts/config.ts.txt";
import authorContractsEnumsTypescript from "./author-contracts-artifacts/enums.ts.txt";
import authorContractsEvalJavascript from "./author-contracts-artifacts/eval.js.txt";
import authorContractsEvalTypescript from "./author-contracts-artifacts/eval.ts.txt";
import authorContractsJavascript from "./author-contracts-artifacts/index.js.txt";
import authorContractsTypescript from "./author-contracts-artifacts/index.ts.txt";
import authorContractsLoggerTypescript from "./author-contracts-artifacts/logger.ts.txt";
import authorContractsProcessTypescript from "./author-contracts-artifacts/process.ts.txt";
import authorContractsStateTypescript from "./author-contracts-artifacts/state.ts.txt";
import authorContractsTestJavascript from "./author-contracts-artifacts/test.js.txt";
import authorContractsTestTypescript from "./author-contracts-artifacts/test.ts.txt";
import { generateFeatureApisDeclaration } from "./feature-apis.ts";
import { generateFeatureHooksDeclaration } from "./feature-hooks.ts";

const JSON_INDENT = 2;
const PACKAGE_SYNC_ERROR_EXIT_CODE = -1;

const StringRecordSchema = Schema.Record(Schema.String, Schema.String);
const PackageJsonSchema = Schema.Struct({
  dependencies: Schema.optionalKey(StringRecordSchema),
  optionalDependencies: Schema.optionalKey(StringRecordSchema),
});
const decodePackageJsonShapeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PackageJsonSchema)
);

class ProjectInitError extends Schema.TaggedError<ProjectInitError>()(
  "ProjectInitError",
  {
    detail: Schema.String,
    exitCode: Schema.Number,
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {
  override get message(): string {
    return `Project initialization failed while ${this.operation}: ${this.detail}`;
  }
}

const authorContractsPackageJson = (): {
  dependencies: Record<string, string>;
  exports: Record<string, { default: string; types: string }>;
  name: string;
  private: boolean;
  type: string;
  version: string;
} => ({
  dependencies: {
    [PLATFORM_BUN_PACKAGE]: PLATFORM_BUN_PACKAGE_VERSION,
    [EFFECT_PACKAGE]: EFFECT_PACKAGE_VERSION,
    [SLACK_TYPES_PACKAGE]: SLACK_TYPES_PACKAGE_VERSION,
  },
  exports: {
    ".": {
      default: "./index.ts",
      types: "./index.ts",
    },
    "./config": {
      default: "./config.ts",
      types: "./config.ts",
    },
    "./enums": {
      default: "./enums.ts",
      types: "./enums.ts",
    },
    "./eval": {
      default: "./eval.ts",
      types: "./eval.ts",
    },
    "./logger": {
      default: "./logger.ts",
      types: "./logger.ts",
    },
    "./process": {
      default: "./process.ts",
      types: "./process.ts",
    },
    "./state": {
      default: "./state.ts",
      types: "./state.ts",
    },
    "./test": {
      default: "./test.ts",
      types: "./test.ts",
    },
  },
  name: AUTHOR_CONTRACTS_PACKAGE,
  private: true,
  type: "module",
  version: "0.0.0",
});

const writeAuthorContractsCache = Effect.fn(
  "ProjectInit.writeAuthorContractsCache"
)(function* (input: {
  readonly fs: FileSystem.FileSystem;
  readonly oriDirectory: OriDirectory["Service"];
  readonly projectRoot: string;
}) {
  const path = yield* Path.Path;
  const targetRoot = input.oriDirectory.authorContractsCacheDir(
    input.projectRoot
  );
  const files = {
    "config.ts": authorContractsConfigTypescript,
    "enums.ts": authorContractsEnumsTypescript,
    "eval.ts": authorContractsEvalTypescript,
    "index.ts": authorContractsTypescript,
    "logger.ts": authorContractsLoggerTypescript,
    // Scaffold codegen of a fixed, self-produced package.json. There is no
    // untrusted input to validate, so a schema round-trip adds nothing.
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    "package.json": `${JSON.stringify(authorContractsPackageJson(), null, JSON_INDENT)}\n`,
    "process.ts": authorContractsProcessTypescript,
    "state.ts": authorContractsStateTypescript,
    "test.ts": authorContractsTestTypescript,
  };

  yield* input.fs.makeDirectory(targetRoot, { recursive: true });
  for (const [name, expected] of Object.entries(files)) {
    const filePath = path.join(targetRoot, name);
    const current = yield* input.fs
      .readFileString(filePath)
      .pipe(Effect.option);
    if (Option.getOrUndefined(current) !== expected) {
      yield* input.fs.writeFileString(filePath, expected);
    }
  }
});

const refreshFeatureHooksDeclaration = Effect.fn(
  "ProjectInit.refreshFeatureHooksDeclaration"
)(function* (input: {
  readonly featuresRoot: string;
  readonly projectRoot: string;
}) {
  yield* generateFeatureHooksDeclaration(input).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectInitError({
          cause,
          detail: formatUnknownError(cause),
          exitCode: PACKAGE_SYNC_ERROR_EXIT_CODE,
          operation: "refreshing generated feature hooks declaration",
        })
    )
  );
});

const refreshFeatureApisDeclaration = Effect.fn(
  "ProjectInit.refreshFeatureApisDeclaration"
)(function* (input: {
  readonly featuresRoot: string;
  readonly projectRoot: string;
}) {
  yield* generateFeatureApisDeclaration(input).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectInitError({
          cause,
          detail: formatUnknownError(cause),
          exitCode: PACKAGE_SYNC_ERROR_EXIT_CODE,
          operation: "refreshing generated feature apis declaration",
        })
    )
  );
});

const syncAuthorContracts = Effect.fn("ProjectInit.syncAuthorContracts")(
  function* (
    projectRoot: string
  ): Effect.fn.Return<
    void,
    PlatformError.PlatformError | ProjectInitError,
    FileSystem.FileSystem | OriDirectory | Path.Path
  > {
    const fs = yield* FileSystem.FileSystem;
    const oriDirectory = yield* OriDirectory;
    yield* writeAuthorContractsCache({
      fs,
      oriDirectory,
      projectRoot,
    });
    const path = yield* Path.Path;
    yield* refreshFeatureHooksDeclaration({
      featuresRoot: path.join(projectRoot, "features"),
      projectRoot,
    });
    yield* refreshFeatureApisDeclaration({
      featuresRoot: path.join(projectRoot, "features"),
      projectRoot,
    });
  }
);

const readPackageJsonShape = Effect.fn("ProjectInit.readPackageJsonShape")(
  function* (fs: FileSystem.FileSystem, packageJsonPath: string) {
    const raw = yield* fs.readFileString(packageJsonPath);
    return yield* decodePackageJsonShapeJson(raw).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectInitError({
            detail: formatUnknownError(cause),
            exitCode: PACKAGE_SYNC_ERROR_EXIT_CODE,
            operation: "decoding package.json for author contract refresh",
            cause,
          })
      )
    );
  }
);

/**
 * Materialize (or refresh) the `.ori/sdk` author-contracts cache for an
 * *existing* workspace, but only when the project opts in by declaring the `ori`
 * author-contracts file dependency (`"ori": "file:.ori/sdk"`) in its root
 * package.json, under either `dependencies` or `optionalDependencies`. The
 * optional form lets a project that is also fetched as a remote `--features`
 * source (where `.ori/sdk` never exists) install cleanly instead of failing
 * `npm install` outright on an unresolvable required dependency. This is the
 * safe, idempotent path shared by `ori dev` and the existing-workspace branch
 * of `ori init` (e.g. `postinstall: ori init .`): unrelated directories are
 * left untouched.
 *
 * Returns `true` when the directory is an Ori workspace and the cache is now
 * current, and `false` when it is skipped (no package.json, or the contracts
 * dependency is absent from both fields). Callers use the boolean to
 * distinguish "synced an existing workspace" from "this is not an Ori
 * workspace".
 */
export const ensureAuthorContractsCurrent = Effect.fn(
  "ProjectInit.ensureAuthorContractsCurrent"
)(function* (
  projectRoot: string,
  featuresRoot?: string
): Effect.fn.Return<
  boolean,
  PlatformError.PlatformError | ProjectInitError,
  FileSystem.FileSystem | OriDirectory | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const oriDirectory = yield* OriDirectory;
  const packageJsonPath = path.join(projectRoot, "package.json");
  const hasPackageJson = yield* fs.exists(packageJsonPath);
  if (!hasPackageJson) {
    return false;
  }

  const packageJsonShape = yield* readPackageJsonShape(fs, packageJsonPath);
  const contractsDependency =
    packageJsonShape.dependencies?.[AUTHOR_CONTRACTS_PACKAGE] ??
    packageJsonShape.optionalDependencies?.[AUTHOR_CONTRACTS_PACKAGE];
  if (contractsDependency !== AUTHOR_CONTRACTS_PACKAGE_VERSION) {
    return false;
  }

  yield* writeAuthorContractsCache({
    fs,
    oriDirectory,
    projectRoot,
  });
  yield* refreshFeatureHooksDeclaration({
    featuresRoot: featuresRoot ?? path.join(projectRoot, "features"),
    projectRoot,
  });
  yield* refreshFeatureApisDeclaration({
    featuresRoot: featuresRoot ?? path.join(projectRoot, "features"),
    projectRoot,
  });
  return true;
});

export {
  authorContractsEvalJavascript,
  authorContractsJavascript,
  authorContractsTestJavascript,
  ProjectInitError,
  syncAuthorContracts,
};
