import { Effect, FileSystem, Option, Path, Schema } from "effect";

import type { FeaturePackageInfo } from "./dependency-types.ts";
import type { ResolvedFeature } from "./feature-loader-types.ts";

import { InvalidPackageJsonDiagnostic } from "./dependency-diagnostics.ts";
import { emptyPackageInfo } from "./dependency-types.ts";

const PACKAGE_JSON = "package.json";

const FeaturePackageJsonSchema = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  name: Schema.optionalKey(Schema.NonEmptyString),
});
const decodeFeaturePackageJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FeaturePackageJsonSchema)
);

const readFeaturePackage = Effect.fn("FeatureDependencyPlan.readPackage")(
  function* (featureDir: string, featureId: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packagePath = path.join(featureDir, PACKAGE_JSON);
    const present = yield* fs
      .exists(packagePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!present) {
      return emptyPackageInfo(featureId);
    }

    const decoded = yield* fs
      .readFileString(packagePath)
      .pipe(Effect.flatMap(decodeFeaturePackageJson), Effect.option);

    if (Option.isNone(decoded)) {
      return {
        ...emptyPackageInfo(featureId),
        diagnostics: [new InvalidPackageJsonDiagnostic({ featureId })],
      } satisfies FeaturePackageInfo;
    }

    return {
      dependencies: decoded.value.dependencies ?? {},
      diagnostics: [],
      featureId,
      ...(decoded.value.name ? { name: decoded.value.name } : {}),
    } satisfies FeaturePackageInfo;
  }
);

export const readFeaturePackages = Effect.fn(
  "FeatureDependencyPlan.readPackages"
)(function* (featuresRoot: string, features: readonly ResolvedFeature[]) {
  const path = yield* Path.Path;
  return yield* Effect.all(
    features.map((feature) =>
      readFeaturePackage(path.join(featuresRoot, feature.id), feature.id)
    )
  );
});
