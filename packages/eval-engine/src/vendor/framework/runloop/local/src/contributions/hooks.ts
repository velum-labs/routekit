import { Effect, Result } from "effect";

import type { ResolvedFeature } from "../../../../engine/features/src/feature-loader-types.ts";
import type { ContributionSet } from "./imported-contribution.ts";

import { decodeHooksContribution } from "../../../../contracts/internal/src/author-schemas/hooks.ts";
import {
  combineContributionSets,
  disabledFeatureContributionSet,
  makeContributionSourcePath,
  makeProjectContributionSet,
} from "./imported-contribution.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

export interface HooksRegistryEntry {
  readonly featureId: string;
  readonly hooks: Readonly<Record<string, unknown>>;
}

export type ImportedHooksContributions = ContributionSet<HooksRegistryEntry>;

export const importHooksContributionsFromFeatures = (
  featuresRoot: string,
  features: readonly ResolvedFeature[]
): Effect.Effect<ImportedHooksContributions> =>
  Effect.all(
    features.map((feature) => {
      if (!feature.valid) {
        return Effect.succeed(
          disabledFeatureContributionSet<HooksRegistryEntry>("hooks", feature)
        );
      }
      return Effect.all(
        feature.contributions
          .filter((contribution) => contribution.entryKey === "hooks")
          .map((contribution) => {
            const value = contribution.moduleNamespace?.hooks;
            return decodeHooksContribution(value).pipe(
              Effect.result,
              Effect.map((decoded) => {
                const sourcePath = makeContributionSourcePath({
                  contribution,
                  feature,
                  featuresRoot,
                  joinPath: (...segments) => segments.join("/"),
                });
                if (Result.isFailure(decoded)) {
                  return makeProjectContributionSet({
                    diagnostics: [
                      `hooks export for feature "${feature.id}" is not a valid HooksContribution: ${formatUnknownError(decoded.failure)}`,
                    ],
                    entries: [],
                    feature,
                    kind: "hooks",
                    sourcePath,
                  });
                }
                return makeProjectContributionSet({
                  diagnostics: [],
                  entries: [
                    {
                      featureId: feature.id,
                      hooks: Object.fromEntries(
                        Object.entries(decoded.success)
                      ),
                    },
                  ],
                  feature,
                  kind: "hooks",
                  sourcePath,
                });
              })
            );
          })
      ).pipe(
        Effect.map(
          (sets): ImportedHooksContributions => combineContributionSets(sets)
        )
      );
    })
  ).pipe(
    Effect.map(
      (sets): ImportedHooksContributions => combineContributionSets(sets)
    )
  );
