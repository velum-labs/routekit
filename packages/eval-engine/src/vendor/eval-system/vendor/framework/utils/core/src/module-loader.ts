import type { PlatformError } from "effect";
import type { Plugin } from "esbuild";

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Context, Data, Effect, FileSystem, Path, Schema } from "effect";
import * as esbuild from "esbuild";

import { formatUnknownError } from "./error-formatting.ts";
import { resolveBarePackageSpecifier } from "./package-resolver.ts";

const DefaultExportValuesSchema = Schema.ArrayEnsure(Schema.Unknown);
const FreshModuleSchema = Schema.Record(Schema.String, Schema.Unknown);
const EMPTY_COUNT = 0;
const INITIAL_POLICY_NAMESPACE = 0;
const noActiveImportScope = (): ModuleImportScope | undefined => undefined;
const noCustomBuildPlugins = (): readonly FreshModuleBuildPlugin[] => [];
const ModuleImportScopeRef = Context.Reference<ModuleImportScope | undefined>(
  "routekit-eval/kernel/ModuleImportScope",
  {
    defaultValue: noActiveImportScope,
  }
);
// Bun's module loader caches by realpath and ignores query strings, so a fresh
// evaluation requires importing a distinct on-disk artifact. We bundle the
// module graph to a unique temporary file (local imports inlined, packages kept
// external) and cache the decoded result so unaffected modules are reused.
const freshModuleCache = new Map<string, FreshModule>();
const freshModulePolicyNamespaces = new WeakMap<
  FreshModuleBuildPolicy,
  number
>();
let nextFreshModulePolicyNamespace = INITIAL_POLICY_NAMESPACE;
interface ModuleImportScope {
  readonly affectedFeatureIds: ReadonlySet<string>;
  readonly featuresRoot: string;
}

type FreshModuleBuildPlugin = Plugin;

interface FreshModuleBuildPolicy {
  readonly packages: "bundle" | "external";
  readonly plugins?: readonly FreshModuleBuildPlugin[];
}

const defaultFreshModuleBuildPolicy: FreshModuleBuildPolicy = {
  packages: "external",
  plugins: noCustomBuildPlugins(),
};
const FreshModuleBuildPolicyRef = Context.Reference<FreshModuleBuildPolicy>(
  "routekit-eval/kernel/FreshModuleBuildPolicy",
  {
    defaultValue: () => defaultFreshModuleBuildPolicy,
  }
);

// Kept so callers compile. On Node there is no compiled-binary virtual
// filesystem, so this is always false. Packed-intern launches still force
// `packages: "bundle"` via import-policy rather than this probe.
const isCompiledStandaloneBinary = (): boolean => false;

const decodeDefaultExportValues = Schema.decodeUnknownEffect(
  DefaultExportValuesSchema
);
const decodeFreshModule = Schema.decodeUnknownEffect(FreshModuleSchema);

type FreshModule = typeof FreshModuleSchema.Type;

const withAffectedModuleImportScope = <Value, Error, Requirements>(
  input: {
    readonly affectedFeatureIds?: readonly string[] | undefined;
    readonly featuresRoot: string;
  },
  effect: Effect.Effect<Value, Error, Requirements>
): Effect.Effect<Value, Error, Requirements> =>
  Effect.provideService(
    effect,
    ModuleImportScopeRef,
    input.affectedFeatureIds === undefined
      ? undefined
      : {
          affectedFeatureIds: new Set(input.affectedFeatureIds),
          featuresRoot: input.featuresRoot,
        }
  );

const withFreshModuleBuildPolicy = <Value, Error, Requirements>(
  policy: FreshModuleBuildPolicy,
  effect: Effect.Effect<Value, Error, Requirements>
): Effect.Effect<Value, Error, Requirements> =>
  Effect.provideService(effect, FreshModuleBuildPolicyRef, policy);

const shouldImportFresh = (
  absolute: string,
  activeImportScope: ModuleImportScope | undefined
): boolean => {
  if (activeImportScope === undefined) {
    return true;
  }
  if (activeImportScope.affectedFeatureIds.size === EMPTY_COUNT) {
    // Empty affected set: no feature changed, so every module remains stable.
    // This is distinct from no scope, which imports every module fresh.
    return false;
  }

  for (const featureId of activeImportScope.affectedFeatureIds) {
    const prefix = `${activeImportScope.featuresRoot}/${featureId}/`;
    if (absolute.startsWith(prefix)) {
      return true;
    }
  }
  return false;
};

const freshModuleCacheKey = (
  absolute: string,
  buildPolicy: FreshModuleBuildPolicy
): string => {
  const existingNamespace = freshModulePolicyNamespaces.get(buildPolicy);
  if (existingNamespace !== undefined) {
    return `${existingNamespace}\0${absolute}`;
  }

  const namespace = nextFreshModulePolicyNamespace;
  nextFreshModulePolicyNamespace += 1;
  freshModulePolicyNamespaces.set(buildPolicy, namespace);
  return `${namespace}\0${absolute}`;
};

// The bundler never consults the importer's `package.json` "imports" map for
// `#`-prefixed subpath specifiers: it leaves them as bare specifiers in the
// emitted artifact. That artifact is later `import()`ed from a temp directory
// under `node_modules` (see `freshOutputBaseDirectory`), well outside the
// source package's own directory tree, so the runtime resolver can't find a
// `package.json` declaring the map either. Resolving `#`-specifiers ourselves
// at build time, rooted at the importing source file, sidesteps both gaps.
//
// The `#` filter is exact, not a heuristic: per the Node.js "imports" field
// spec, every entry in that map must start with `#`
// (https://nodejs.org/api/packages.html#subpath-imports), so no bare or
// scoped package specifier (e.g. `effect`, `@routekit-eval-runloop/local/layers`) can
// ever be an `imports`-field match. Those already resolve correctly through
// the bundler (it understands `exports` maps, workspace symlinks, and
// self-referencing package names natively), so widening this filter would
// only add a guaranteed-miss resolution attempt to every ordinary import in
// every fresh-module build, without ever finding anything the `#` filter
// wouldn't already catch.
const resolveSpecifierFromImporter = (
  specifier: string,
  importer: string
): string => createRequire(importer).resolve(specifier);

const nodeImportsFieldSubpathPlugin: FreshModuleBuildPlugin = {
  name: "routekit-eval-resolve-node-imports-field-subpaths",
  setup(build) {
    build.onResolve({ filter: /^#/u }, (args) => ({
      path: resolveSpecifierFromImporter(
        args.path,
        args.importer === ""
          ? join(args.resolveDir, "package.json")
          : args.importer
      ),
    }));
  },
};

const barePackageSpecifierFilter =
  /^(?!node:|bun:)(?![A-Za-z]:[\\/])[^./#][^/]*(?:\/.*)?$/u;

// Isolated installs can encode a `file:../pkg` dependency as a store directory
// containing a literal `..` sequence in a path segment (not only a real parent
// traversal). Returning such a path from onResolve has historically failed the
// build on some bundlers, so hand the specifier back (return undefined) rather
// than forcing a path the bundler will reject. Every consumer of this plugin
// runs under the `packages: "bundle"` policy, where the bundler resolves such
// a package natively.
const BUN_ONRESOLVE_REJECTED_SEQUENCE = "..";

export const resolveBarePackageImportsPlugin: FreshModuleBuildPlugin = {
  name: "routekit-eval-resolve-bare-package-imports",
  setup(build) {
    build.onResolve({ filter: barePackageSpecifierFilter }, (args) => {
      const path = resolveBarePackageSpecifier(args.path, args.importer);
      return path === undefined ||
        path.includes(BUN_ONRESOLVE_REJECTED_SEQUENCE)
        ? undefined
        : { path };
    });
  },
};

const formatModuleLoaderCause = (cause: unknown): string =>
  formatUnknownError(cause);

// Tagged error so the Effect error channel stays typed (`ModuleLoaderError`)
// instead of the opaque global `Error` the language-service flags
// (globalErrorInEffectCatch / globalErrorInEffectFailure). `Data.TaggedError`
// still extends the global `Error`, so an `Effect<Value, ModuleLoaderError>`
// remains assignable to the `Effect<Value, Error>` callers bridge through. The
// `message` getter reproduces the exact strings these sites previously threw.
const MODULE_LOADER_PHASE_MESSAGE = {
  build: "Failed to build module for fresh import",
  import: "Failed to import fresh module",
} as const;

class ModuleLoaderError extends Data.TaggedError("ModuleLoaderError")<{
  readonly phase: "build" | "import";
  readonly absolute: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `${MODULE_LOADER_PHASE_MESSAGE[this.phase]}: ${this.absolute}\n${this.detail}`;
  }
}

const moduleLoaderCatch =
  (absolute: string, phase: "build" | "import") =>
  (cause: unknown): ModuleLoaderError =>
    new ModuleLoaderError({
      absolute,
      cause,
      detail: formatModuleLoaderCause(cause),
      phase,
    });

const freshOutputBaseDirectory = Effect.fn(
  "ModuleLoader.freshOutputBaseDirectory"
)(function* (absolute: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = path.dirname(absolute);
  for (;;) {
    if (yield* fs.exists(path.join(directory, "node_modules"))) {
      return path.join(directory, "node_modules");
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return;
    }
    directory = parent;
  }
});

// The output directory uses `makeTempDirectoryScoped`, so it is reclaimed when
// the surrounding scope closes — including on interruption or defect, not only
// on normal return.
const buildAndImportFresh = Effect.fn("ModuleLoader.buildAndImportFresh")(
  function* (absolute: string, buildPolicy: FreshModuleBuildPolicy) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outputDirectory = yield* fs.makeTempDirectoryScoped({
      directory: yield* freshOutputBaseDirectory(absolute),
      prefix: "routekit-eval-fresh-",
    });
    const built = yield* Effect.tryPromise({
      catch: moduleLoaderCatch(absolute, "build"),
      try: () =>
        esbuild.build({
          bundle: true,
          entryPoints: [absolute],
          format: "esm",
          outfile: join(outputDirectory, "module.mjs"),
          ...(buildPolicy.packages === "external"
            ? { packages: "external" as const }
            : {}),
          platform: "node",
          plugins: [
            nodeImportsFieldSubpathPlugin,
            ...(buildPolicy.plugins ?? []),
          ],
          write: true,
        }),
    });
    if (built.errors.length > 0) {
      const logs = built.errors.map((message) => message.text).join("\n");
      return yield* new ModuleLoaderError({
        absolute,
        detail: logs,
        phase: "build",
      });
    }
    return yield* Effect.tryPromise({
      catch: moduleLoaderCatch(absolute, "import"),
      try: (): Promise<unknown> =>
        import(pathToFileURL(path.join(outputDirectory, "module.mjs")).href),
    });
  }
);

export const importFreshModule = Effect.fn("ModuleLoader.importFreshModule")(
  function* (absolute: string) {
    const activeImportScope = yield* Effect.service(ModuleImportScopeRef);
    const buildPolicy = yield* Effect.service(FreshModuleBuildPolicyRef);
    const cacheKey = freshModuleCacheKey(absolute, buildPolicy);
    if (!shouldImportFresh(absolute, activeImportScope)) {
      const cached = freshModuleCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const evaluated = yield* Effect.scoped(
      buildAndImportFresh(absolute, buildPolicy)
    ).pipe(Effect.flatMap(decodeFreshModule));
    freshModuleCache.set(cacheKey, evaluated);
    return evaluated;
  }
);

export const importFreshDefaultExport = (
  absolute: string
): Effect.Effect<
  unknown,
  ModuleLoaderError | PlatformError.PlatformError | Schema.SchemaError,
  FileSystem.FileSystem | Path.Path
> => importFreshModule(absolute).pipe(Effect.map((module) => module.default));

export const importFreshNamedExport = (
  absolute: string,
  exportName: string
): Effect.Effect<
  unknown,
  ModuleLoaderError | PlatformError.PlatformError | Schema.SchemaError,
  FileSystem.FileSystem | Path.Path
> =>
  importFreshModule(absolute).pipe(Effect.map((module) => module[exportName]));

export {
  defaultFreshModuleBuildPolicy,
  isCompiledStandaloneBinary,
  decodeDefaultExportValues,
  withAffectedModuleImportScope,
  withFreshModuleBuildPolicy,
  ModuleLoaderError,
};
export type { FreshModuleBuildPlugin, FreshModuleBuildPolicy, FreshModule };
