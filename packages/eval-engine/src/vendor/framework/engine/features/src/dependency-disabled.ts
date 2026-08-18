import type { DependencyDiagnostic } from "./dependency-diagnostics.ts";
import type { ResolvedFeature } from "./feature-loader-types.ts";

import { DisabledByDependencyDiagnostic } from "./dependency-diagnostics.ts";

interface DisabledPropagation {
  readonly diagnostics: readonly DependencyDiagnostic[];
  readonly disabled: ReadonlySet<string>;
}

const findNextDisabledDependent = (input: {
  readonly disabled: ReadonlySet<string>;
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly features: readonly ResolvedFeature[];
}):
  | {
      readonly dependencyId: string;
      readonly feature: ResolvedFeature;
    }
  | undefined =>
  input.features.flatMap((feature) => {
    if (input.disabled.has(feature.id) || !feature.valid) {
      return [];
    }
    const dependencyId = [...(input.edges.get(feature.id) ?? [])].find((id) =>
      input.disabled.has(id)
    );
    return dependencyId === undefined
      ? []
      : [
          {
            dependencyId,
            feature,
          },
        ];
  })[0];

export const propagateDisabledDependencies = (input: {
  readonly diagnostics: readonly DependencyDiagnostic[];
  readonly disabled: ReadonlySet<string>;
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly features: readonly ResolvedFeature[];
}): DisabledPropagation => {
  const diagnostics = [...input.diagnostics];
  const disabled = new Set(input.disabled);

  for (;;) {
    const next = findNextDisabledDependent({
      disabled,
      edges: input.edges,
      features: input.features,
    });
    if (next === undefined) {
      return {
        diagnostics,
        disabled,
      };
    }

    diagnostics.push(
      new DisabledByDependencyDiagnostic({
        dependencyId: next.dependencyId,
        featureId: next.feature.id,
      })
    );
    disabled.add(next.feature.id);
  }
};

export type { DisabledPropagation };
