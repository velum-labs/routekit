import { readFileSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join } from "node:path";

import { Option, Schema } from "effect";

interface PackageExportsRecord {
  readonly [key: string]: PackageExports;
}

type PackageExports =
  | string
  | null
  | readonly PackageExports[]
  | PackageExportsRecord;

const PackageExportsSchema: Schema.Codec<PackageExports> = Schema.suspend(
  (): Schema.Codec<PackageExports> =>
    Schema.Union([
      Schema.String,
      Schema.Null,
      Schema.Array(
        Schema.suspend((): Schema.Codec<PackageExports> => PackageExportsSchema)
      ),
      Schema.Record(
        Schema.String,
        Schema.suspend((): Schema.Codec<PackageExports> => PackageExportsSchema)
      ),
    ]) as Schema.Codec<PackageExports>
);

const PackageJsonSchema: Schema.Codec<{
  readonly exports?: PackageExports;
  readonly main?: string;
}> = Schema.Struct({
  exports: Schema.optionalKey(PackageExportsSchema),
  main: Schema.optionalKey(Schema.String),
});

const decodePackageJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(PackageJsonSchema)
);

const isPackageExportsArray = (
  value: PackageExports
): value is readonly PackageExports[] => Array.isArray(value);

const isPackageExportsRecord = (
  value: PackageExports
): value is PackageExportsRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveExportTarget = (value: PackageExports): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (isPackageExportsArray(value)) {
    for (const target of value) {
      const resolved = resolveExportTarget(target);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return undefined;
  }
  if (value === null) {
    return undefined;
  }
  if (!isPackageExportsRecord(value)) {
    return undefined;
  }
  const record = value;
  for (const condition of ["node", "import", "require", "default"]) {
    const target = record[condition];
    if (target !== undefined) {
      const resolved = resolveExportTarget(target);
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }
  return undefined;
};

export const resolvePackageExport = (
  exports: PackageExports,
  subpath: string
): string | undefined => {
  if (typeof exports === "string") {
    return subpath === "." ? exports : undefined;
  }
  if (isPackageExportsArray(exports) || exports === null) {
    return resolveExportTarget(exports);
  }
  if (!isPackageExportsRecord(exports)) {
    return undefined;
  }
  const record = exports;
  const exact = record[subpath];
  if (exact !== undefined) {
    return resolveExportTarget(exact);
  }
  const wildcardMatches: {
    readonly prefix: string;
    readonly suffix: string;
    readonly value: PackageExports;
  }[] = [];
  for (const [key, value] of Object.entries(record)) {
    const wildcardIndex = key.indexOf("*");
    const hasSingleWildcard =
      wildcardIndex !== -1 && wildcardIndex === key.lastIndexOf("*");
    if (!hasSingleWildcard) {
      continue;
    }
    const prefix = key.slice(0, wildcardIndex);
    const suffix = key.slice(wildcardIndex + 1);
    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= prefix.length + suffix.length
    ) {
      wildcardMatches.push({
        prefix,
        suffix,
        value,
      });
    }
  }
  const [wildcardMatch] = wildcardMatches.toSorted(
    (left, right) =>
      right.prefix.length - left.prefix.length ||
      right.suffix.length - left.suffix.length
  );
  if (wildcardMatch !== undefined) {
    const { prefix, suffix, value } = wildcardMatch;
    const target = resolveExportTarget(value);
    const capture = subpath.slice(
      prefix.length,
      subpath.length - suffix.length
    );
    return target?.replaceAll("*", capture);
  }
  return subpath === "." &&
    !Object.keys(record).some((key) => key.startsWith("."))
    ? resolveExportTarget(exports)
    : undefined;
};

const packageNameAndSubpath = (
  specifier: string
): readonly [string, string] => {
  const segments = specifier.split("/");
  const packageSegmentCount = specifier.startsWith("@") ? 2 : 1;
  const packageName = segments.slice(0, packageSegmentCount).join("/");
  const subpath =
    segments.length > packageSegmentCount
      ? `./${segments.slice(packageSegmentCount).join("/")}`
      : ".";
  return [packageName, subpath];
};

const validateResolvedPath = (resolved: string): string | undefined => {
  if (!isAbsolute(resolved)) {
    return undefined;
  }
  try {
    const realPath = realpathSync(resolved);
    return statSync(realPath).isFile() ? realPath : undefined;
  } catch {
    return undefined;
  }
};

const resolveFileTarget = (
  packageDirectory: string,
  target: string
): string | undefined => {
  const candidatePaths = [
    target,
    `${target}.js`,
    `${target}.ts`,
    `${target}.mjs`,
    `${target}.cjs`,
    join(target, "index.js"),
    join(target, "index.ts"),
  ];
  for (const candidate of candidatePaths) {
    const resolved = validateResolvedPath(join(packageDirectory, candidate));
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
};

interface ResolvedPackage {
  readonly directory: string;
  readonly packageJson: {
    readonly exports?: PackageExports;
    readonly main?: string;
  };
}

const packageDirectoryCandidates = (
  directory: string,
  packageName: string
): readonly string[] => [join(directory, "node_modules", packageName)];

const readPackageJsonOption = Option.liftThrowable(
  (packageDirectory: string): ResolvedPackage["packageJson"] =>
    decodePackageJson(
      readFileSync(join(packageDirectory, "package.json"), "utf-8")
    )
);

const readPackageJson = (
  packageDirectory: string
): ResolvedPackage["packageJson"] | undefined =>
  Option.getOrUndefined(readPackageJsonOption(packageDirectory));

const findPackage = (
  importerDirectory: string,
  packageName: string
): ResolvedPackage | undefined => {
  let directory = importerDirectory;
  for (;;) {
    for (const packageDirectory of packageDirectoryCandidates(
      directory,
      packageName
    )) {
      const packageJson = readPackageJson(packageDirectory);
      if (packageJson !== undefined) {
        return {
          directory: packageDirectory,
          packageJson,
        };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
};

export const resolveBarePackageSpecifier = (
  specifier: string,
  importer: string
): string | undefined => {
  if (isBuiltin(specifier)) {
    return undefined;
  }
  const [packageName, subpath] = packageNameAndSubpath(specifier);
  const importerDirectory = dirname(importer);
  const resolvedPackage = findPackage(importerDirectory, packageName);
  if (resolvedPackage === undefined) {
    return undefined;
  }
  const { directory, packageJson } = resolvedPackage;
  let target: string | undefined;
  if (packageJson.exports !== undefined) {
    target = resolvePackageExport(packageJson.exports, subpath);
  } else if (subpath === ".") {
    target = packageJson.main ?? "index.js";
  } else {
    target = subpath.startsWith("./") ? subpath.slice(2) : subpath;
  }
  if (target === undefined) {
    return undefined;
  }
  return resolveFileTarget(directory, target);
};
