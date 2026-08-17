import {
  buildLunaAccuracyPrompt,
  type LunaAccuracyMatrixV2,
  type LunaAccuracyPrompt,
} from "./luna-accuracy-context.ts";
import {
  auditLunaAccuracyCodingAnnotations,
  codingEpisodeIdsFromAnnotations,
  type LunaAccuracyCodingAnnotation,
} from "./luna-accuracy-coding-annotations.ts";
import {
  buildLunaAccuracySelectionReport,
  buildLunaAccuracyTreatmentSelectionReport,
  type LunaAccuracyDataSource,
  type LunaAccuracySelectionReport,
  type LunaAccuracyTreatmentSelectionReport,
} from "./luna-accuracy-report.ts";
import {
  auditLunaAccuracyTreatmentDistinctness,
  type LunaAccuracyTreatmentDistinctnessAudit,
} from "./luna-accuracy-distinctness.ts";
import {
  buildLunaAccuracyProviderRequest,
  LUNA_ACCURACY_CANONICAL_MODEL,
  LUNA_ACCURACY_MODEL,
  LUNA_ACCURACY_PROVIDER,
  LUNA_ACCURACY_TRANSPORT_POLICY,
} from "./luna-accuracy-openrouter.ts";
import {
  assertLunaAccuracyRunComplete,
  buildLunaAccuracyArchitecturePrompt,
  buildLunaAccuracyJobSchedule,
  buildLunaAccuracyPredictionSets,
  lunaAccuracyCallKey,
  normalizeLunaAccuracyArms,
  validateLunaAccuracyRunManifestBinding,
  type LunaAccuracyCallRecord,
  type LunaAccuracyCallStage,
  type LunaAccuracyExperimentArm,
  type LunaAccuracyPipelineJob,
  type LunaAccuracyRunManifest,
} from "./luna-accuracy-runner.ts";
import type { LunaAccuracyDatasetRole } from "./luna-accuracy-workflow.ts";
import { contentHash } from "./hash.ts";
import type {
  AreaCardV1,
  RepositoryProfileV1,
  SilverLabelV1,
  TaskEpisode,
} from "./types.ts";
import { validateBenchmarkDataset } from "./validation.ts";

export const LUNA_ACCURACY_ANALYSIS_ATTESTATION_VERSION =
  "luna-accuracy-analysis-v2-pinned-transport-treatments" as const;

export interface LunaAccuracyAnalysisAttestationV2 {
  schemaVersion: 1;
  attestationVersion: typeof LUNA_ACCURACY_ANALYSIS_ATTESTATION_VERSION;
  generatedAt: string;
  model: string;
  datasetRole: LunaAccuracyDatasetRole;
  dataSource: LunaAccuracyDataSource;
  hashes: {
    runManifest: string;
    completedCalls: string;
    labels: string;
    codingAnnotations: string;
    transportPolicy: string;
    manifestTransport: string;
    distinctnessAudit: string;
    report: string;
    treatmentReport: string;
  };
  counts: {
    calls: number;
    labels: number;
    codingAnnotations: number;
    predictionSets: number;
    treatments: number;
  };
  reportProvenance: LunaAccuracySelectionReport["provenance"];
  treatmentReportProvenance:
    LunaAccuracyTreatmentSelectionReport["provenance"];
}

/** Retained as a source-compatible name while its value is now strict V2. */
export type LunaAccuracyAnalysisAttestationV1 =
  LunaAccuracyAnalysisAttestationV2;

export interface LunaAccuracyAttestedAnalysis {
  report: LunaAccuracySelectionReport;
  treatmentReport: LunaAccuracyTreatmentSelectionReport;
  distinctnessAudit: LunaAccuracyTreatmentDistinctnessAudit;
  attestation: LunaAccuracyAnalysisAttestationV2;
  predictionSets: ReturnType<typeof buildLunaAccuracyPredictionSets>;
}

export interface BuildLunaAccuracyAttestedAnalysisInput {
  model: string;
  datasetRole: LunaAccuracyDatasetRole;
  dataSource: LunaAccuracyDataSource;
  profile: RepositoryProfileV1;
  cards: AreaCardV1[];
  episodes: TaskEpisode[];
  labels: SilverLabelV1[];
  codingAnnotations: LunaAccuracyCodingAnnotation[];
  matrix: LunaAccuracyMatrixV2;
  calls: LunaAccuracyCallRecord[];
  runManifest: LunaAccuracyRunManifest;
  arms?: LunaAccuracyExperimentArm[];
  generatedAt?: string;
}

const lexicalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalCalls = (
  calls: readonly LunaAccuracyCallRecord[],
): LunaAccuracyCallRecord[] =>
  [...calls].sort((left, right) => lexicalCompare(left.key, right.key));

const canonicalLabels = (labels: readonly SilverLabelV1[]): SilverLabelV1[] =>
  [...labels].sort((left, right) =>
    lexicalCompare(left.taskEpisodeId, right.taskEpisodeId)
  );

const canonicalAnnotations = (
  annotations: readonly LunaAccuracyCodingAnnotation[],
): LunaAccuracyCodingAnnotation[] =>
  [...annotations].sort((left, right) =>
    lexicalCompare(left.taskEpisodeId, right.taskEpisodeId)
  );

const stageFor = (
  calls: readonly LunaAccuracyCallRecord[],
  job: LunaAccuracyPipelineJob,
  stage: LunaAccuracyCallStage,
): LunaAccuracyCallRecord => {
  const key = lunaAccuracyCallKey(job, stage);
  const matches = calls.filter((record) => record.key === key);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one completed ${stage} call for attestation job ${job.key}`,
    );
  }
  return matches[0]!;
};

const expectedPrompt = (
  base: LunaAccuracyPrompt,
  calls: readonly LunaAccuracyCallRecord[],
  job: LunaAccuracyPipelineJob,
  stage: LunaAccuracyCallStage,
): LunaAccuracyPrompt => {
  if (stage === "single" || stage === "member") return base;
  if (stage === "proposal") {
    return buildLunaAccuracyArchitecturePrompt({
      base,
      stage: "proposal",
    });
  }
  const proposal = stageFor(calls, job, "proposal").prediction;
  if (stage === "verify") {
    return buildLunaAccuracyArchitecturePrompt({
      base,
      stage: "verify",
      proposal,
    });
  }
  const verification = stageFor(calls, job, "verify").prediction;
  return buildLunaAccuracyArchitecturePrompt({
    base,
    stage: "revise",
    proposal,
    verification,
  });
};

const expectedStages = (
  architecture: LunaAccuracyExperimentArm["architecture"],
): LunaAccuracyCallStage[] =>
  architecture === "single_call"
    ? ["single"]
    : architecture === "self_consistency_3"
    ? ["member"]
    : ["proposal", "verify", "revise"];

const validateCallBindings = (input: {
  model: string;
  calls: readonly LunaAccuracyCallRecord[];
  schedule: readonly LunaAccuracyPipelineJob[];
  profile: RepositoryProfileV1;
  cards: readonly AreaCardV1[];
  episodes: readonly TaskEpisode[];
  matrix: LunaAccuracyMatrixV2;
}): void => {
  const episodes = new Map(
    input.episodes.map((episode) => [episode.id, episode]),
  );
  const variants = new Map(
    input.matrix.variants.map((variant) => [variant.id, variant]),
  );
  for (const job of input.schedule) {
    const episode = episodes.get(job.taskEpisodeId);
    const variant = variants.get(job.variantId);
    if (!episode || !variant) {
      throw new Error(`Invalid attestation schedule job ${job.key}`);
    }
    const base = buildLunaAccuracyPrompt({
      episode,
      profile: input.profile,
      cards: [...input.cards],
      variant,
      repetitionIndex: job.repetitionIndex,
    });
    for (const stage of expectedStages(job.architecture)) {
      const record = stageFor(input.calls, job, stage);
      const prompt = expectedPrompt(base, input.calls, job, stage);
      if (record.promptHash !== contentHash(prompt)) {
        throw new Error(
          `Completed call prompt hash does not match runtime inputs: ${record.key}`,
        );
      }
      const providerRequestHash = contentHash(
        buildLunaAccuracyProviderRequest({
          model: input.model,
          prompt,
          variant,
          allowedAreaIds: input.cards.map((card) => card.areaId),
          stage: stage === "single" || stage === "member"
            ? "classify"
            : stage,
          seed: job.seed,
        }),
      );
      if (
        record.transport.policyVersion !==
          LUNA_ACCURACY_TRANSPORT_POLICY.version ||
        record.transport.providerRequestHash !== providerRequestHash ||
        record.transport.providerName !== LUNA_ACCURACY_PROVIDER ||
        record.transport.responseModel !== LUNA_ACCURACY_MODEL ||
        record.transport.catalogCanonicalModel !==
          LUNA_ACCURACY_CANONICAL_MODEL
      ) {
        throw new Error(
          `Completed call transport does not match runtime inputs: ${record.key}`,
        );
      }
    }
  }
};

const stableGeneratedAt = (
  input: BuildLunaAccuracyAttestedAnalysisInput,
): string => {
  const generatedAt = input.generatedAt ?? input.runManifest.createdAt;
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("Analysis attestation generatedAt must be an ISO date");
  }
  return generatedAt;
};

export const buildLunaAccuracyAttestedAnalysis = (
  input: BuildLunaAccuracyAttestedAnalysisInput,
): LunaAccuracyAttestedAnalysis => {
  validateBenchmarkDataset(
    input.profile,
    input.cards,
    input.episodes,
    input.labels,
  );
  const codingAudit = auditLunaAccuracyCodingAnnotations(
    input.episodes,
    input.codingAnnotations,
  );
  if (!codingAudit.ready) {
    throw new Error("Analysis attestation requires complete coding annotations");
  }
  const arms = normalizeLunaAccuracyArms(input.matrix, input.arms);
  validateLunaAccuracyRunManifestBinding({
    manifest: input.runManifest,
    model: input.model,
    profile: input.profile,
    cards: input.cards,
    episodes: input.episodes,
    matrix: input.matrix,
    arms,
  });
  const schedule = buildLunaAccuracyJobSchedule({
    matrix: input.matrix,
    episodes: input.episodes,
    arms,
    scheduleSeed: input.runManifest.scheduleSeed,
  });
  assertLunaAccuracyRunComplete({
    records: input.calls,
    schedule,
    inputHash: input.runManifest.inputHash,
    allowedAreaIds: input.cards.map((card) => card.areaId),
  });
  validateCallBindings({
    model: input.model,
    calls: input.calls,
    schedule,
    profile: input.profile,
    cards: input.cards,
    episodes: input.episodes,
    matrix: input.matrix,
  });
  const codingEpisodeIds = codingEpisodeIdsFromAnnotations(
    input.episodes,
    input.codingAnnotations,
  );
  const predictionSets = buildLunaAccuracyPredictionSets({
    records: input.calls,
    episodes: input.episodes,
    matrix: input.matrix,
    arms,
  });
  const generatedAt = stableGeneratedAt(input);
  const report = buildLunaAccuracySelectionReport({
    model: input.model,
    datasetRole: input.datasetRole,
    dataSource: input.dataSource,
    episodes: input.episodes,
    labels: input.labels,
    codingEpisodeIds,
    predictionSets,
    runManifest: input.runManifest,
    matrix: input.matrix,
    arms,
    generatedAt,
  });
  const distinctnessAudit = auditLunaAccuracyTreatmentDistinctness({
    model: input.model,
    profile: input.profile,
    cards: input.cards,
    episodes: input.episodes,
    matrix: input.matrix,
    arms,
  });
  const treatmentReport = buildLunaAccuracyTreatmentSelectionReport({
    model: input.model,
    datasetRole: input.datasetRole,
    dataSource: input.dataSource,
    episodes: input.episodes,
    labels: input.labels,
    codingEpisodeIds,
    predictionSets,
    runManifest: input.runManifest,
    matrix: input.matrix,
    arms,
    distinctnessAudit,
    generatedAt,
  });
  const attestation: LunaAccuracyAnalysisAttestationV2 = {
    schemaVersion: 1,
    attestationVersion: LUNA_ACCURACY_ANALYSIS_ATTESTATION_VERSION,
    generatedAt,
    model: input.model,
    datasetRole: input.datasetRole,
    dataSource: input.dataSource,
    hashes: {
      runManifest: contentHash(input.runManifest),
      completedCalls: contentHash(canonicalCalls(input.calls)),
      labels: contentHash(canonicalLabels(input.labels)),
      codingAnnotations:
        contentHash(canonicalAnnotations(input.codingAnnotations)),
      transportPolicy: contentHash(LUNA_ACCURACY_TRANSPORT_POLICY),
      manifestTransport: contentHash(input.runManifest.transport),
      distinctnessAudit: contentHash(distinctnessAudit),
      report: contentHash(report),
      treatmentReport: contentHash(treatmentReport),
    },
    counts: {
      calls: input.calls.length,
      labels: input.labels.length,
      codingAnnotations: input.codingAnnotations.length,
      predictionSets: predictionSets.length,
      treatments: treatmentReport.treatments,
    },
    reportProvenance: { ...report.provenance },
    treatmentReportProvenance: { ...treatmentReport.provenance },
  };
  return {
    report,
    treatmentReport,
    distinctnessAudit,
    attestation,
    predictionSets,
  };
};

export const validateLunaAccuracyAnalysisAttestation = (
  input: BuildLunaAccuracyAttestedAnalysisInput & {
    report: LunaAccuracySelectionReport;
    treatmentReport?: LunaAccuracyTreatmentSelectionReport;
    distinctnessAudit?: LunaAccuracyTreatmentDistinctnessAudit;
    attestation: LunaAccuracyAnalysisAttestationV2;
  },
): LunaAccuracyAttestedAnalysis => {
  const attestation = input.attestation;
  if (
    attestation.schemaVersion !== 1 ||
    attestation.attestationVersion !==
      LUNA_ACCURACY_ANALYSIS_ATTESTATION_VERSION ||
    attestation.model !== input.model ||
    attestation.datasetRole !== input.datasetRole ||
    attestation.dataSource !== input.dataSource
  ) {
    throw new Error("Invalid or mismatched Luna accuracy analysis attestation");
  }
  const rebuilt = buildLunaAccuracyAttestedAnalysis({
    ...input,
    generatedAt: attestation.generatedAt,
  });
  if (
    contentHash(attestation) !== contentHash(rebuilt.attestation) ||
    contentHash(input.report) !== rebuilt.attestation.hashes.report ||
    (
      input.treatmentReport !== undefined &&
      contentHash(input.treatmentReport) !==
        rebuilt.attestation.hashes.treatmentReport
    ) ||
    (
      input.distinctnessAudit !== undefined &&
      contentHash(input.distinctnessAudit) !==
        rebuilt.attestation.hashes.distinctnessAudit
    )
  ) {
    throw new Error(
      "Luna accuracy analysis attestation or report does not match raw inputs",
    );
  }
  return rebuilt;
};
