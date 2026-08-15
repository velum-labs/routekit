import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { Context, Effect, Layer, Schema } from "effect";

import type {
  FreshModuleBuildPlugin,
  FreshModuleBuildPolicy,
} from "../../../../utils/core/src/module-loader.ts";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { isPackedInternEnv } from "../../../../contracts/internal/src/cli/intern-launcher-env.ts";
import { preserveImportMetaAssetUrlsPlugin } from "../../../../utils/core/src/import-meta-asset-url/esbuild-plugin.ts";
import {
  defaultFreshModuleBuildPolicy,
  isCompiledStandaloneBinary,
  resolveBarePackageImportsPlugin,
} from "../../../../utils/core/src/module-loader.ts";

const OPTIONAL_DEVTOOLS_STUB_NAMESPACE = "routekit-eval-optional-devtools-stub";
const REACT_DEVTOOLS_CORE_PACKAGE = "react-devtools-core";

const OptionalPeerPackageJsonSchema = Schema.Struct({
  peerDependencies: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String)
  ),
  peerDependenciesMeta: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        optional: Schema.optionalKey(Schema.Boolean),
      })
    )
  ),
});
const decodeOptionalPeerPackageJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(OptionalPeerPackageJsonSchema)
);

interface FreshModuleBuildRuntime {
  // True when routekit-eval is running as a compiled standalone binary, where fresh
  // feature modules must be bundled rather than left to resolve their packages
  // from disk at runtime. Defaults to `isCompiledStandaloneBinary()`, which is
  // always false on Node; packed-intern env still forces bundling.
  readonly isCompiledStandalone?: boolean;
}

const readOptionalPeerPackageJson = (
  path: string
): typeof OptionalPeerPackageJsonSchema.Type | undefined => {
  try {
    return decodeOptionalPeerPackageJson(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
};

const findNearestPackageJson = (importer: string): string | undefined => {
  let directory = dirname(importer);
  for (;;) {
    const packageJsonPath = join(directory, "package.json");
    if (existsSync(packageJsonPath)) {
      return packageJsonPath;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
};

const shouldStubMissingOptionalReactDevtoolsPeer = (
  importer: string
): boolean => {
  try {
    createRequire(importer).resolve(REACT_DEVTOOLS_CORE_PACKAGE);
    return false;
  } catch {
    const packageJsonPath = findNearestPackageJson(importer);
    if (packageJsonPath === undefined) {
      return false;
    }
    const packageJson = readOptionalPeerPackageJson(packageJsonPath);
    return (
      packageJson?.peerDependencies?.[REACT_DEVTOOLS_CORE_PACKAGE] !==
        undefined &&
      packageJson.peerDependenciesMeta?.[REACT_DEVTOOLS_CORE_PACKAGE]
        ?.optional === true
    );
  }
};

const optionalReactDevtoolsCoreStubPlugin: FreshModuleBuildPlugin = {
  name: "routekit-eval-optional-react-devtools-core-stub",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/u }, (args) => {
      if (shouldStubMissingOptionalReactDevtoolsPeer(args.importer)) {
        return {
          namespace: OPTIONAL_DEVTOOLS_STUB_NAMESPACE,
          path: args.path,
        };
      }
    });
    build.onLoad(
      {
        filter: /.*/u,
        namespace: OPTIONAL_DEVTOOLS_STUB_NAMESPACE,
      },
      () => ({
        contents: [
          "export const initialize = () => {};",
          "export const connectToDevTools = () => {};",
          "export default { initialize, connectToDevTools };",
          "",
        ].join("\n"),
        loader: "js",
      })
    );
  },
};

const packedFeatureFreshModuleBuildPolicy: FreshModuleBuildPolicy = {
  packages: "bundle",
  plugins: [
    preserveImportMetaAssetUrlsPlugin,
    optionalReactDevtoolsCoreStubPlugin,
    resolveBarePackageImportsPlugin,
  ],
};

// A source launch keeps `packages: "external"` (no bundling of dependencies),
// but still needs the import.meta rewrite plugin. Every feature.ts is loaded by
// bundling it into a fresh `routekit-eval-fresh-*` temp dir, so `import.meta.dir(name)` and
// `new URL(..., import.meta.url)` resolve to that temp dir at runtime, not the
// feature's source — an on-disk asset read (e.g. `readdir(import.meta.dir)`) then
// throws ENOENT. The default policy carried no plugins, so source-launched
// features hit this the same way packed ones would; keeping the plugin here closes
// that gap without pulling in the packed policy's dependency bundling.
const sourceLaunchFeatureFreshModuleBuildPolicy: FreshModuleBuildPolicy = {
  packages: defaultFreshModuleBuildPolicy.packages,
  plugins: [preserveImportMetaAssetUrlsPlugin],
};

// Both packed-intern launches and compiled standalone binaries load feature
// modules from a context where on-disk package resolution of the emitted
// artifact is unavailable, so both require the bundling policy. A normal
// `node` source launch keeps the lighter external policy (but still rewrites
// import.meta asset references so bundled feature modules resolve them to source).
export const freshModuleBuildPolicyForEnv = (
  env: NodeJS.ProcessEnv,
  runtime: FreshModuleBuildRuntime = {}
): FreshModuleBuildPolicy =>
  isPackedInternEnv(env) ||
  (runtime.isCompiledStandalone ?? isCompiledStandaloneBinary())
    ? packedFeatureFreshModuleBuildPolicy
    : sourceLaunchFeatureFreshModuleBuildPolicy;

export class FeatureImportPolicy extends Context.Service<
  FeatureImportPolicy,
  FreshModuleBuildPolicy
>()("routekit-eval/runtime/FeatureImportPolicy") {
  static readonly layer = Layer.effect(
    FeatureImportPolicy,
    Effect.gen(function* () {
      const hostProcess = yield* HostProcess;
      return FeatureImportPolicy.of(
        freshModuleBuildPolicyForEnv(yield* hostProcess.env)
      );
    })
  );
}

export type { FreshModuleBuildRuntime };
