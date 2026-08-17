import {
  buildLunaAccuracyPrompt,
  type LunaAccuracyMatrixV2,
  type LunaAccuracyVariantV2,
} from "./luna-accuracy-context.ts";
import { contentHash } from "./hash.ts";
import { buildLunaAccuracyProviderRequest } from "./luna-accuracy-openrouter.ts";
import {
  buildLunaAccuracyArchitecturePrompt,
  lunaAccuracyAreaRegistryHash,
  lunaAccuracyArmsHash,
  lunaAccuracyMatrixHash,
  lunaAccuracyModelHash,
  lunaAccuracyProfileHash,
  lunaAccuracyRuntimeEpisodesHash,
  normalizeLunaAccuracyArms,
  type LunaAccuracyArchitecture,
  type LunaAccuracyExperimentArm,
} from "./luna-accuracy-runner.ts";
import type {
  AreaCardV1,
  RepositoryProfileV1,
  TaskEpisode,
} from "./types.ts";

export interface LunaAccuracyTreatmentPair {
  leftArmId: string;
  rightArmId: string;
  architecture: LunaAccuracyArchitecture;
  alignedRequests: number;
  identicalRequests: number;
  distinctRequests: number;
  exposureRate: number;
  fullyEquivalent: boolean;
}

export interface LunaAccuracyTreatmentEquivalenceClass {
  treatmentId: string;
  architecture: LunaAccuracyArchitecture;
  memberArmIds: string[];
  alignedRequestsPerArm: number;
}

export interface LunaAccuracyTreatmentDistinctnessAudit {
  schemaVersion: 1;
  model: string;
  provenance: {
    modelHash: string;
    profileHash: string;
    registryHash: string;
    datasetHash: string;
    matrixHash: string;
    armsHash: string;
  };
  cases: number;
  arms: number;
  requestStages: Array<"classify" | "proposal">;
  requestFingerprints: number;
  equivalentPairs: LunaAccuracyTreatmentPair[];
  partiallyExposedPairs: LunaAccuracyTreatmentPair[];
  equivalenceClasses: LunaAccuracyTreatmentEquivalenceClass[];
}

const requestStage = (
  architecture: LunaAccuracyArchitecture,
): "classify" | "proposal" =>
  architecture === "proposal_verify_revise" ? "proposal" : "classify";

const armRequestFingerprints = (input: {
  model: string;
  profile: RepositoryProfileV1;
  cards: readonly AreaCardV1[];
  episodes: readonly TaskEpisode[];
  arm: LunaAccuracyExperimentArm;
  variant: LunaAccuracyVariantV2;
}): Map<string, string> => {
  const allowedAreaIds = input.cards.map((card) => card.areaId);
  const fingerprints = new Map<string, string>();
  for (const episode of [...input.episodes].sort((left, right) =>
    left.id.localeCompare(right.id)
  )) {
    for (
      let repetitionIndex = 0;
      repetitionIndex < input.variant.repetitions;
      repetitionIndex += 1
    ) {
      const prompt = buildLunaAccuracyPrompt({
        episode,
        profile: input.profile,
        cards: [...input.cards],
        variant: input.variant,
        repetitionIndex,
      });
      const providerPrompt =
        input.arm.architecture === "proposal_verify_revise"
          ? buildLunaAccuracyArchitecturePrompt({
              base: prompt,
              stage: "proposal",
            })
          : prompt;
      const alignmentKey = contentHash({
        taskEpisodeId: episode.id,
        seed: prompt.seed,
        stage: requestStage(input.arm.architecture),
      });
      fingerprints.set(
        alignmentKey,
        contentHash(
          buildLunaAccuracyProviderRequest({
            model: input.model,
            prompt: providerPrompt,
            variant: input.variant,
            allowedAreaIds,
            stage: requestStage(input.arm.architecture),
            seed: prompt.seed,
          }),
        ),
      );
    }
  }
  return fingerprints;
};

const compareAligned = (
  leftArm: LunaAccuracyExperimentArm,
  rightArm: LunaAccuracyExperimentArm,
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): LunaAccuracyTreatmentPair | undefined => {
  if (leftArm.architecture !== rightArm.architecture) {
    return undefined;
  }
  const alignedKeys = [...left.keys()]
    .filter((key) => right.has(key))
    .sort();
  if (alignedKeys.length === 0) return undefined;
  let identicalRequests = 0;
  for (const key of alignedKeys) {
    if (left.get(key) === right.get(key)) identicalRequests += 1;
  }
  const distinctRequests = alignedKeys.length - identicalRequests;
  const fullyEquivalent =
    distinctRequests === 0 &&
    alignedKeys.length === left.size &&
    alignedKeys.length === right.size;
  return {
    leftArmId: leftArm.id,
    rightArmId: rightArm.id,
    architecture: leftArm.architecture,
    alignedRequests: alignedKeys.length,
    identicalRequests,
    distinctRequests,
    exposureRate: distinctRequests / alignedKeys.length,
    fullyEquivalent,
  };
};

const equivalenceClasses = (
  arms: readonly LunaAccuracyExperimentArm[],
  fingerprints: ReadonlyMap<string, ReadonlyMap<string, string>>,
): LunaAccuracyTreatmentEquivalenceClass[] => {
  const byTreatment = new Map<
    string,
    { architecture: LunaAccuracyArchitecture; armIds: string[]; count: number }
  >();
  for (const arm of arms) {
    const values = fingerprints.get(arm.id)!;
    const requestFingerprints = [...values.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    );
    const treatmentId = contentHash({
      schemaVersion: 1,
      architecture: arm.architecture,
      requestFingerprints,
    });
    const current = byTreatment.get(treatmentId) ?? {
      architecture: arm.architecture,
      armIds: [],
      count: values.size,
    };
    current.armIds.push(arm.id);
    byTreatment.set(treatmentId, current);
  }
  return [...byTreatment.entries()]
    .filter(([, value]) => value.armIds.length > 1)
    .map(([treatmentId, value]) => ({
      treatmentId,
      architecture: value.architecture,
      memberArmIds: value.armIds.sort(),
      alignedRequestsPerArm: value.count,
    }))
    .sort((left, right) =>
      left.memberArmIds[0]!.localeCompare(right.memberArmIds[0]!)
    );
};

/**
 * Compares provider-visible request bodies over every aligned case and fixed
 * seed. It records hashes and counts only; task text and prompts are never
 * returned or persisted.
 *
 * For proposal/verify/revise arms, this audits the proposal request plus the
 * shared architecture. Later requests depend on stochastic prior decisions,
 * so they cannot be known before paid execution.
 */
export const auditLunaAccuracyTreatmentDistinctness = (input: {
  model: string;
  profile: RepositoryProfileV1;
  cards: AreaCardV1[];
  episodes: TaskEpisode[];
  matrix: LunaAccuracyMatrixV2;
  arms?: LunaAccuracyExperimentArm[];
}): LunaAccuracyTreatmentDistinctnessAudit => {
  const arms = normalizeLunaAccuracyArms(input.matrix, input.arms);
  const variants = new Map(
    input.matrix.variants.map((variant) => [variant.id, variant]),
  );
  const fingerprints = new Map(
    arms.map((arm) => [
      arm.id,
      armRequestFingerprints({
        model: input.model,
        profile: input.profile,
        cards: input.cards,
        episodes: input.episodes,
        arm,
        variant: variants.get(arm.variantId)!,
      }),
    ]),
  );
  const pairs: LunaAccuracyTreatmentPair[] = [];
  for (let leftIndex = 0; leftIndex < arms.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < arms.length;
      rightIndex += 1
    ) {
      const pair = compareAligned(
        arms[leftIndex]!,
        arms[rightIndex]!,
        fingerprints.get(arms[leftIndex]!.id)!,
        fingerprints.get(arms[rightIndex]!.id)!,
      );
      if (pair) pairs.push(pair);
    }
  }
  return {
    schemaVersion: 1,
    model: input.model,
    provenance: {
      modelHash: lunaAccuracyModelHash(input.model),
      profileHash: lunaAccuracyProfileHash(input.profile),
      registryHash: lunaAccuracyAreaRegistryHash(input.cards),
      datasetHash: lunaAccuracyRuntimeEpisodesHash(input.episodes),
      matrixHash: lunaAccuracyMatrixHash(input.matrix),
      armsHash: lunaAccuracyArmsHash(input.matrix, arms),
    },
    cases: input.episodes.length,
    arms: arms.length,
    requestStages: [...new Set(arms.map((arm) =>
      requestStage(arm.architecture)
    ))].sort(),
    requestFingerprints: [...fingerprints.values()].reduce(
      (sum, values) => sum + values.size,
      0,
    ),
    equivalentPairs: pairs.filter((pair) => pair.fullyEquivalent),
    partiallyExposedPairs: pairs.filter(
      (pair) => !pair.fullyEquivalent && pair.identicalRequests > 0,
    ),
    equivalenceClasses: equivalenceClasses(arms, fingerprints),
  };
};

export const assertLunaAccuracyTreatmentsDistinct = (
  audit: LunaAccuracyTreatmentDistinctnessAudit,
  allowEquivalentTreatmentReplicates = false,
): void => {
  if (
    !allowEquivalentTreatmentReplicates &&
    audit.equivalenceClasses.length > 0
  ) {
    const aliases = audit.equivalenceClasses
      .map((group) => group.memberArmIds.join("="))
      .join(", ");
    throw new Error(
      `Luna accuracy run contains provider-identical treatment arms: ${aliases}. Explicitly allow equivalent treatment replicates only when they will be analyzed as repeated configurations.`,
    );
  }
};
