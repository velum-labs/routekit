import type {
  LunaAccuracyMatrixV2,
  LunaAccuracyVariantV2,
} from "./luna-accuracy-context.ts";
import type {
  LunaAccuracyPhaseTwoBSelection,
} from "./luna-accuracy-confirmation.ts";
import { lunaAccuracyMatrixHash } from "./luna-accuracy-runner.ts";

export interface LunaAccuracyPhaseThreeContexts {
  primary: LunaAccuracyVariantV2;
  alternative: LunaAccuracyVariantV2;
}

/**
 * Chooses the two frozen contexts used by Phase 3 after the Phase 2b
 * selection artifact has been rebuilt and validated from raw inputs.
 *
 * The selected context must itself be stable. The alternative is the
 * highest-scoring stable non-selected context, with a lexical ID tie-break.
 * If either requirement is unmet, Phase 3 fails closed rather than testing
 * architectures on an unstable or fabricated context.
 */
export const selectLunaAccuracyPhaseThreeContexts = (input: {
  matrix: LunaAccuracyMatrixV2;
  selection: LunaAccuracyPhaseTwoBSelection;
}): LunaAccuracyPhaseThreeContexts => {
  if (
    input.selection.outcome === "no_stable_configuration" ||
    input.selection.provenance.matrixHash !==
      lunaAccuracyMatrixHash(input.matrix)
  ) {
    throw new Error(
      "Phase 3 requires a stable Phase 2b selection bound to its matrix",
    );
  }
  const matrixById = new Map(
    input.matrix.variants.map((variant) => [variant.id, variant]),
  );
  if (matrixById.size !== input.matrix.variants.length) {
    throw new Error("Phase 2b matrix contains duplicate variant IDs");
  }
  const analysisById = new Map(
    input.selection.variants.map((variant) => [
      variant.variantId,
      variant,
    ]),
  );
  if (
    analysisById.size !== input.selection.variants.length ||
    analysisById.size !== matrixById.size ||
    [...matrixById.keys()].some((id) => !analysisById.has(id))
  ) {
    throw new Error(
      "Phase 2b selection variants do not exactly match its matrix",
    );
  }
  const primaryAnalysis = analysisById.get(
    input.selection.selectedVariantId,
  );
  const primary = matrixById.get(input.selection.selectedVariantId);
  if (!primary || !primaryAnalysis?.stability.passed) {
    throw new Error(
      "Phase 2b selected context did not pass every stability gate",
    );
  }
  const alternativeAnalysis = input.selection.variants
    .filter(
      (variant) =>
        variant.variantId !== input.selection.selectedVariantId &&
        variant.stability.passed,
    )
    .sort(
      (left, right) =>
        right.meanSelectionScore - left.meanSelectionScore ||
        left.variantId.localeCompare(right.variantId),
    )[0];
  const alternative = alternativeAnalysis
    ? matrixById.get(alternativeAnalysis.variantId)
    : undefined;
  if (!alternative) {
    throw new Error(
      "Phase 3 requires a stable alternative Phase 2b context",
    );
  }
  return { primary, alternative };
};
