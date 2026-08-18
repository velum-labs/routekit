#!/usr/bin/env node
import { resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { collectCodexEpisodes } from "./codex-collector.ts";
import { buildDatasetQualityReport } from "./dataset-quality.ts";
import { adjudicateSilverLabels } from "./adjudication.ts";
import { freezeRegistry } from "./registry-freeze.ts";
import { calculateExtendedMetrics, pairedBootstrapDifference } from "./experiment-metrics.ts";
import { applyLunaConfidenceThreshold, buildAreaVectors, buildHiddenAreaVectors, classifyAllEmbeddingMethods, simulateAreaRefresh, simulateCascade, tuneLunaConfidence, tuneThresholds, withholdArea, type SavedVectorArtifact } from "./experiment-runner.ts";
import { renderClassificationReport } from "./report.ts";
import { curateEpisodes, type CurationDecision } from "./curation.ts";
import { buildRepresentationEmbeddingInputs, embedRepresentationInputs } from "./embedding-run.ts";
import { EmbeddingCache } from "./embedding-cache.ts";
import {
  classifyTaskKindWithLuna,
  classifyWithLuna,
} from "./openrouter.ts";
import { renderLunaAreaCards, serializeRepresentation } from "./experiment-runner.ts";
import { buildGroupedReport } from "./group-report.ts";
import { captureEnvironment } from "./environment.ts";
import { inventoryCodexRepositories } from "./codex-inventory.ts";
import { estimateTokens, fetchEmbeddingModelPrices, fetchModelPrices, maximumCallCost } from "./cost.ts";
import { readJsonl, writeJsonlPrivate } from "./jsonl.ts";
import { buildOraclePrompt, runSilverOracle } from "./oracle.ts";
import type { AreaCardV1, RepositoryProfileV1, SilverLabelV1, TaskEpisode } from "./types.ts";
import { buildRouteKitSeed, writeRouteKitSeed } from "./routekit-seed.ts";
import { createRunDirectory, writeImmutable } from "./run-artifacts.ts";
import { getOpenRouterKeyStatus } from "./openrouter.ts";
import { BudgetLedger } from "./budget.ts";
import { selectOracleCanary } from "./canary.ts";
import {
  auditSilverLabelRepositoryEvidence,
  validateAreaCards,
  validateBenchmarkDataset,
  validateEpisodes,
  validateRepositoryProfile,
  validateSilverLabels,
} from "./validation.ts";
import { encryptTransfer, generateTransferKeyPair, importTransfer } from "./transfer.ts";
import { CODEX_HARNESS_INPUT_OVERHEAD_TOKENS_PER_CALL, EXPERIMENT_BUDGET_CEILING_USD, TASK_CONTEXT_REPRESENTATION } from "./config.ts";
import { buildReferenceRegistry } from "./registry-builder.ts";
import { buildSliceReport } from "./slice-report.ts";
import { auditOracleTraces, type CanonicalTraceSource } from "./oracle-trace-audit.ts";
import {
  renderLunaAreaContext,
  serializeLunaTaskContext,
  validateLunaBenchmarkMatrix,
  type LunaBenchmarkMatrix,
} from "./luna-context.ts";
import {
  buildLunaBenchmarkReport,
  buildLunaEnsembleReport,
  representativeLunaPredictions,
  selectStratifiedLunaCanary,
} from "./luna-benchmark.ts";
import {
  buildLunaCascadeVariantReport,
  combineLunaCascadePrediction,
  validateLunaCascadeMatrix,
  type LunaCascadeMatrix,
  type LunaTaskKindPredictionV1,
} from "./luna-cascade.ts";
import {
  auditOraclePassCoverage,
  buildCodingChallengeSuite,
  buildResolvedDevelopmentSubset,
  buildValidationEscalationPlan,
  mergeOraclePassArtifacts,
  readUnlockedEpisodeSplits,
  recoverOraclePassesFromTraces,
  selectCanonicalOraclePasses,
  selectDisagreementEpisodes,
  selectEpisodeSplit,
  selectSecondPassEpisodes,
  selectLunaAccuracyDevelopmentCanary,
} from "./dataset-prep.ts";
import {
  validateLunaAccuracyMatrixV2,
  type LunaAccuracyMatrixV2,
} from "./luna-accuracy-context.ts";
import {
  buildLunaAccuracyAttestedAnalysis,
  type LunaAccuracyAnalysisAttestationV1,
} from "./luna-accuracy-attestation.ts";
import {
  buildLunaAccuracyPhaseOneMatrix,
  buildLunaAccuracyPhaseThreeDesign,
  buildLunaAccuracyPhaseTwoBMatrix,
  buildLunaAccuracyPhaseTwoMatrix,
  validateLunaAccuracyPhaseOneTransition,
  validateLunaAccuracyPhaseTwoTransition,
  type LunaAccuracyFreezeRecord,
} from "./luna-accuracy-design.ts";
import {
  buildLunaAccuracyPhaseTwoBSelection,
  validateLunaAccuracyPhaseTwoBSelection,
  type LunaAccuracyPhaseTwoBSelection,
} from "./luna-accuracy-confirmation.ts";
import {
  selectLunaAccuracyPhaseThreeContexts,
} from "./luna-accuracy-phase-transitions.ts";
import {
  buildLunaAccuracyPhaseThreeSelection,
} from "./luna-accuracy-phase3.ts";
import { buildLunaCounterfactualChallengeSuite } from "./luna-accuracy-challenges.ts";
import {
  compareLunaAccuracyTopTwo,
  LUNA_ACCURACY_DATA_SOURCES,
  type LunaAccuracyDataSource,
  type LunaAccuracySelectionReport,
} from "./luna-accuracy-report.ts";
import {
  createLunaAccuracyOpenRouterExecutor,
  LUNA_ACCURACY_MODEL,
} from "./luna-accuracy-openrouter.ts";
import {
  buildLunaAccuracyPredictionSets,
  type LunaAccuracyCallRecord,
  type LunaAccuracyExperimentArm,
  type LunaAccuracyRunManifest,
} from "./luna-accuracy-runner.ts";
import {
  planLunaAccuracyWorkflow,
  runBudgetedLunaAccuracyWorkflow,
  type LunaAccuracyDatasetRole,
} from "./luna-accuracy-workflow.ts";
import { buildLunaGroundedCodingDevelopmentSuite } from "./luna-accuracy-coding-development.ts";
import {
  auditLunaAccuracyCodingAnnotations,
  buildGithubLunaAccuracyCodingAnnotations,
  buildReviewedLunaAccuracyCodingAnnotations,
  codingEpisodeIdsFromAnnotations,
  inheritLunaAccuracyCodingAnnotations,
  type LunaAccuracyCodingAnnotation,
  type LunaAccuracyCodingAnnotationDraft,
} from "./luna-accuracy-coding-annotations.ts";

const args = process.argv.slice(2);
const command = args.shift();
const value = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const required = (name: string): string => { const result = value(name); if (!result) throw new Error(`Missing ${name}`); return result; };
const has = (name: string): boolean => args.includes(name);

const writePrivateJson = async (
  file: string,
  valueToWrite: unknown,
): Promise<void> => {
  await mkdir(resolve(file, ".."), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(valueToWrite, null, 2)}\n`, {
    mode: 0o600,
  });
};

const selectBootstrapPredictionSet = (
  sets: readonly ReturnType<typeof buildLunaAccuracyPredictionSets>[number][],
  armId: string,
): ReturnType<typeof buildLunaAccuracyPredictionSets>[number] | undefined => {
  const candidates = sets.filter((set) => set.armId === armId);
  const ensemble = candidates.filter((set) => set.repetitionIndex === null);
  if (ensemble.length > 1) {
    throw new Error(
      `Multiple ensemble prediction sets found for bootstrap arm ${armId}`,
    );
  }
  if (ensemble.length === 1) return ensemble[0];
  return candidates
    .filter((set) => set.repetitionIndex !== null)
    .sort(
      (left, right) =>
        left.repetitionIndex! - right.repetitionIndex! ||
        left.id.localeCompare(right.id),
    )[0];
};

const usage = (): never => {
  console.error(`Usage:
  coding-router-lab collect-codex-episodes --codex-home PATH --user-id ID --repository-id ID --repository-url URL --repository-root PATH --output FILE --diagnostics FILE [--snapshot-fallback SHA] [--since ISO]
  coding-router-lab inventory-codex-repositories --codex-home PATH --output FILE
  coding-router-lab report-dataset-quality --episodes FILE --output FILE [--areas FILE]
  coding-router-lab curate-episodes --episodes FILE --output FILE --report FILE [--decisions FILE] [--reference-fraction N] [--validation-fraction N]
  coding-router-lab freeze-registry --profile FILE --areas FILE --episodes FILE --output FILE [--repository PATH]
  coding-router-lab adjudicate-labels --labels FILE --output FILE --unresolved FILE
  coding-router-lab merge-labels --labels FILE [--labels FILE ...] --output FILE
  coding-router-lab evaluate-predictions --labels FILE --predictions FILE --output FILE
  coding-router-lab compare-predictions --labels FILE --left FILE --right FILE --output FILE [--iterations N] [--seed N]
  coding-router-lab tune-thresholds --labels FILE --predictions FILE --output FILE [--maximum-false-known-rate N]
  coding-router-lab tune-luna-confidence --labels FILE --predictions FILE --output FILE [--maximum-false-known-rate N]
  coding-router-lab apply-luna-confidence --predictions FILE --thresholds FILE --output FILE
  coding-router-lab classify-embeddings --areas FILE --vectors FILE --output-directory DIR --representation task_aware_repo_profile [--thresholds FILE]
  coding-router-lab plan-embedding --profile FILE --areas FILE --episodes FILE --model ID
  coding-router-lab embed-dataset --profile FILE --areas FILE --episodes FILE --model ID --cache DIR --output FILE --artifacts DIR --run-id ID --confirm-external-run
  coding-router-lab plan-luna --profile FILE --areas FILE --episodes FILE --model ID --representation task_aware_repo_profile [--max-output-tokens N]
  coding-router-lab run-luna --profile FILE --areas FILE --episodes FILE --model ID --representation task_aware_repo_profile --output FILE --artifacts DIR --run-id ID --confirm-external-run
  coding-router-lab select-luna-canary --episodes FILE --labels FILE --output FILE [--maximum-cases N]
  coding-router-lab plan-luna-benchmark --profile FILE --areas FILE --episodes FILE --matrix FILE --model ID
  coding-router-lab run-luna-benchmark --profile FILE --areas FILE --episodes FILE --matrix FILE --model ID --labels FILE --artifacts DIR --run-id ID --confirm-external-run [--maximum-cost-usd N]
  coding-router-lab analyze-luna-benchmark --labels FILE --matrix FILE --model ID --prediction VARIANT=FILE [--prediction VARIANT=FILE ...] --output FILE
  coding-router-lab plan-luna-cascade --profile FILE --areas FILE --episodes FILE --matrix FILE --model ID
  coding-router-lab run-luna-cascade --profile FILE --areas FILE --episodes FILE --labels FILE --matrix FILE --model ID --artifacts DIR --run-id ID --confirm-external-run [--maximum-cost-usd N]
  coding-router-lab simulate-cascade --embedding FILE --luna FILE --output FILE
  coding-router-lab withhold-area --areas FILE --labels FILE --area-id ID --output-prefix PATH
  coding-router-lab simulate-refresh --full-areas FILE --hidden-areas FILE --vectors FILE --area-id ID --representation task_aware_repo_profile --output FILE [--thresholds FILE]
  coding-router-lab render-report --run-id ID --labels FILE --prediction NAME=FILE [--prediction NAME=FILE ...] --output FILE [--repository-id ID]
  coding-router-lab report-groups --episodes FILE --labels FILE --predictions FILE --output FILE
  coding-router-lab report-slices --episodes FILE --labels FILE --prediction NAME=FILE [--prediction NAME=FILE ...] --output FILE
  coding-router-lab capture-environment --output FILE
  coding-router-lab generate-transfer-key --private-key FILE --public-key FILE
  coding-router-lab encrypt-transfer --public-key FILE --output FILE --input FILE [--input FILE ...]
  coding-router-lab import-transfer --private-key FILE --input FILE --output-directory DIR
  coding-router-lab build-routekit-seed --pulls FILE --repository PATH --public-output DIR --private-output DIR
  coding-router-lab build-reference-registry --episodes FILE --repository PATH --profile-output FILE --areas-output FILE --assignments-output FILE [--registry-episodes-output FILE] [--supplemental-episodes FILE --supplemental-assignments FILE]
  coding-router-lab prepare-accuracy-dataset --episodes FILE --reference-output FILE --validation-output FILE --validation-plan-output FILE
  coding-router-lab select-oracle-second-pass --episodes FILE --first-pass-labels FILE --validation-plan FILE --output FILE
  coding-router-lab select-oracle-third-pass --episodes FILE --first-pass-labels FILE --second-pass-labels FILE --output FILE
  coding-router-lab recover-oracle-passes --traces DIR --episodes FILE --areas FILE --model ID --passes-output FILE --trace-sources-output FILE --report-output FILE
  coding-router-lab merge-oracle-pass-artifacts --passes FILE --trace-sources FILE [--passes FILE --trace-sources FILE ...] --passes-output FILE --trace-sources-output FILE
  coding-router-lab audit-oracle-pass-coverage --episodes FILE --passes FILE --output FILE
  coding-router-lab select-canonical-oracle-passes --labels FILE --passes FILE --trace-sources FILE --passes-output FILE --trace-sources-output FILE --report-output FILE
  coding-router-lab prepare-coding-challenge --episodes FILE --assignments FILE --areas FILE --episodes-output FILE --evidence-labels-output FILE --report-output FILE [--split validation|test]
  coding-router-lab prepare-luna-accuracy-development --episodes FILE --labels FILE --episodes-output FILE --labels-output FILE --report-output FILE
  coding-router-lab prepare-reviewed-coding-annotations --episodes FILE --drafts FILE --reviewer ID --annotations-output FILE --audit-output FILE
  coding-router-lab prepare-github-coding-annotations --episodes FILE --reviewer ID --annotations-output FILE --audit-output FILE
  coding-router-lab inherit-coding-annotations --source-annotations FILE --derived-episodes FILE --provenance FILE --reviewer ID --annotations-output FILE --audit-output FILE
  coding-router-lab audit-coding-annotations --episodes FILE --annotations FILE --audit-output FILE
  coding-router-lab select-luna-accuracy-canary --episodes FILE --labels FILE --coding-annotations FILE --annotations-output FILE --episodes-output FILE --labels-output FILE --report-output FILE [--maximum-cases N]
  coding-router-lab prepare-luna-coding-development --episodes FILE --assignments FILE --areas FILE --base-episodes-output FILE --base-labels-output FILE --derived-episodes-output FILE --derived-labels-output FILE --provenance-output FILE --report-output FILE
  coding-router-lab generate-luna-accuracy-phase1 --output FILE
  coding-router-lab generate-luna-accuracy-phase2 --phase1-matrix FILE --phase1-report FILE --phase1-manifest FILE --phase1-attestation FILE --profile FILE --areas FILE --episodes FILE --labels FILE --coding-annotations FILE --calls FILE --output FILE
  coding-router-lab generate-luna-accuracy-phase2b --output FILE
  coding-router-lab analyze-luna-accuracy-phase2b --phase2b-matrix FILE --phase2b-manifest FILE --profile FILE --areas FILE --episodes FILE --labels FILE --coding-annotations FILE --calls FILE --selection-output FILE
  coding-router-lab generate-luna-accuracy-phase3 --phase2b-matrix FILE --phase2b-selection FILE --phase2b-manifest FILE --profile FILE --areas FILE --episodes FILE --labels FILE --coding-annotations FILE --calls FILE --matrix-output FILE --arms-output FILE
  coding-router-lab analyze-luna-accuracy-phase3 --matrix FILE --arms FILE --manifest FILE --profile FILE --areas FILE --episodes FILE --labels FILE --coding-annotations FILE --calls FILE --selection-output FILE
  coding-router-lab prepare-luna-accuracy-challenges --episodes FILE --labels FILE --areas FILE --episodes-output FILE --labels-output FILE --provenance-output FILE --scenarios-output FILE [--maximum-source-cases N] [--safe-truncation-ids FILE] [--split validation|test] [--freeze FILE]
  coding-router-lab plan-luna-accuracy --profile FILE --areas FILE --episodes FILE --matrix FILE --data-source real_user|repository_derived|synthetic_counterfactual [--arms FILE] [--dataset-role burned_development|validation|locked_test] [--freeze FILE] [--schedule-seed N] [--concurrency N]
  coding-router-lab run-luna-accuracy --profile FILE --areas FILE --episodes FILE --matrix FILE --labels FILE --coding-annotations FILE --data-source real_user|repository_derived|synthetic_counterfactual --artifacts DIR --run-id ID --confirm-external-run [--arms FILE] [--dataset-role burned_development|validation|locked_test] [--freeze FILE] [--schedule-seed N] [--concurrency N] [--maximum-cost-usd N] [--allow-equivalent-treatment-replicates]
  coding-router-lab analyze-luna-accuracy --profile FILE --areas FILE --episodes FILE --labels FILE --coding-annotations FILE --matrix FILE --calls FILE --manifest FILE --data-source real_user|repository_derived|synthetic_counterfactual --output FILE --treatment-output FILE --distinctness-output FILE --attestation-output FILE --model openai/gpt-5.6-luna --dataset-role burned_development|validation|locked_test [--arms FILE] [--bootstrap-output FILE] [--bootstrap-iterations N] [--bootstrap-seed N]
  coding-router-lab select-canary --episodes FILE --profile FILE --output FILE
  coding-router-lab validate --profile FILE --areas FILE --episodes FILE [--labels FILE]
  coding-router-lab audit-label-evidence --labels FILE --episodes FILE --repository PATH --output FILE
  coding-router-lab audit-oracle-traces --labels FILE --passes FILE --trace-sources FILE --episodes FILE --repository PATH --output FILE
  coding-router-lab plan-oracle --areas FILE --episodes FILE --model ID [--passes N] [--max-output-tokens N]
  coding-router-lab run-oracle --areas FILE --episodes FILE --repository PATH --model ID --artifacts DIR --run-id ID --confirm-external-run [--passes N] [--max-output-tokens N]
`); process.exit(2);
};

const main = async (): Promise<void> => {
  if (command === "inventory-codex-repositories") {
    const output = resolve(required("--output"));
    const inventory = await inventoryCodexRepositories(resolve(required("--codex-home")));
    await writeFile(output, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, output, filesScanned: inventory.filesScanned, repositories: inventory.repositories, sessionsWithoutRepositoryUrl: inventory.sessionsWithoutRepositoryUrl, parseErrors: inventory.parseErrors, privacy: inventory.privacy }, null, 2));
    return;
  }
  if (command === "collect-codex-episodes") {
    const result = await collectCodexEpisodes({
      codexHome: resolve(required("--codex-home")), userId: required("--user-id"), repositoryId: required("--repository-id"),
      ...(value("--repository-url") ? { repositoryUrl: value("--repository-url")! } : {}),
      ...(value("--repository-root") ? { repositoryRoot: resolve(value("--repository-root")!) } : {}),
      ...(value("--snapshot-fallback") ? { repositorySnapshotFallback: value("--snapshot-fallback")! } : {}),
      ...(value("--since") ? { since: value("--since")! } : {}),
      includeAborted: has("--include-aborted"),
    });
    const output = resolve(required("--output"));
    await writeJsonlPrivate(output, result.episodes);
    const diagnosticsOutput = resolve(required("--diagnostics"));
    await writeFile(diagnosticsOutput, `${JSON.stringify(result.diagnostics, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, output, diagnosticsOutput, episodes: result.episodes.length, summary: result.diagnostics }, null, 2));
    return;
  }
  if (command === "report-dataset-quality") {
    const episodes = await readJsonl<TaskEpisode>(resolve(required("--episodes")));
    const cards = value("--areas") ? await readJsonl<AreaCardV1>(resolve(value("--areas")!)) : undefined;
    const report = buildDatasetQualityReport(episodes, cards);
    const output = resolve(required("--output"));
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, output, episodes: report.episodes, ready: report.readiness.ready, failedGates: report.readiness.gates.filter((gate) => !gate.passed).map((gate) => gate.gate), warnings: report.readiness.warnings }, null, 2));
    return;
  }
  if (command === "curate-episodes") {
    const episodes = await readJsonl<TaskEpisode>(resolve(required("--episodes")));
    const decisions = value("--decisions") ? await readJsonl<CurationDecision>(resolve(value("--decisions")!)) : [];
    const result = curateEpisodes(episodes, decisions, {
      reference: Number(value("--reference-fraction") ?? "0.7"),
      validation: Number(value("--validation-fraction") ?? "0.15"),
    });
    await writeJsonlPrivate(resolve(required("--output")), result.episodes);
    await writeFile(resolve(required("--report")), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), ...result.summary, excluded: result.excluded }, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, output: resolve(required("--output")), report: resolve(required("--report")), ...result.summary }, null, 2));
    return;
  }
  if (command === "freeze-registry") {
    const profile = JSON.parse(await readFile(resolve(required("--profile")), "utf8")) as RepositoryProfileV1;
    const cards = await readJsonl<AreaCardV1>(resolve(required("--areas")));
    const episodes = await readJsonl<TaskEpisode>(resolve(required("--episodes")));
    const report = await freezeRegistry(profile, cards, episodes, value("--repository") ? resolve(value("--repository")!) : undefined);
    const output = resolve(required("--output")); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, output, ready: report.ready, failedGates: report.gates.filter((gate) => !gate.passed) }, null, 2));
    return;
  }
  if (command === "adjudicate-labels") {
    const result = adjudicateSilverLabels(await readJsonl<SilverLabelV1>(resolve(required("--labels"))));
    await writeJsonlPrivate(resolve(required("--output")), result.adjudicated);
    await writeFile(resolve(required("--unresolved")), `${JSON.stringify({ schemaVersion: 1, ...result.summary, cases: result.unresolved }, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, ...result.summary, output: resolve(required("--output")), unresolved: resolve(required("--unresolved")) }, null, 2));
    return;
  }
  if (command === "merge-labels") {
    const inputs = args.flatMap((arg, index) =>
      arg === "--labels" && args[index + 1] ? [resolve(args[index + 1]!)] : []
    );
    if (inputs.length < 1) throw new Error("merge-labels requires at least one --labels file");
    const merged: SilverLabelV1[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      for (const label of await readJsonl<SilverLabelV1>(input)) {
        if (seen.has(label.taskEpisodeId)) throw new Error(`Duplicate merged label: ${label.taskEpisodeId}`);
        seen.add(label.taskEpisodeId);
        merged.push(label);
      }
    }
    await writeJsonlPrivate(resolve(required("--output")), merged);
    console.log(JSON.stringify({ ok: true, inputs, output: resolve(required("--output")), labels: merged.length }, null, 2));
    return;
  }
  if (command === "evaluate-predictions") {
    const labels = await readJsonl<SilverLabelV1>(resolve(required("--labels")));
    const predictions = await readJsonl<import("./types.ts").ClassifierPredictionV1>(resolve(required("--predictions")));
    const metrics = calculateExtendedMetrics(labels, predictions);
    await writeFile(resolve(required("--output")), `${JSON.stringify(metrics, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, output: resolve(required("--output")), cases: metrics.core.count, topTwoRecall: metrics.core.topTwoRecall, falseKnownRate: metrics.core.falseKnownRate }, null, 2));
    return;
  }
  if (command === "compare-predictions") {
    const labels = await readJsonl<SilverLabelV1>(resolve(required("--labels")));
    const left = await readJsonl<import("./types.ts").ClassifierPredictionV1>(resolve(required("--left")));
    const right = await readJsonl<import("./types.ts").ClassifierPredictionV1>(resolve(required("--right")));
    const comparison = pairedBootstrapDifference(labels, left, right, Number(value("--iterations") ?? "2000"), Number(value("--seed") ?? "17"));
    await writeFile(resolve(required("--output")), `${JSON.stringify(comparison, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, output: resolve(required("--output")), ...comparison }, null, 2));
    return;
  }
  if (command === "tune-thresholds") {
    const labels = await readJsonl<SilverLabelV1>(resolve(required("--labels")));
    const predictions = await readJsonl<import("./types.ts").ClassifierPredictionV1>(resolve(required("--predictions")));
    const result = tuneThresholds(labels, predictions, Number(value("--maximum-false-known-rate") ?? "0.1"));
    await writeFile(resolve(required("--output")), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, output: resolve(required("--output")), ...result }, null, 2));
    return;
  }
  if (command === "tune-luna-confidence") {
    const result = tuneLunaConfidence(
      await readJsonl<SilverLabelV1>(resolve(required("--labels"))),
      await readJsonl<import("./types.ts").ClassifierPredictionV1>(
        resolve(required("--predictions")),
      ),
      Number(value("--maximum-false-known-rate") ?? "0.1"),
    );
    await writeFile(
      resolve(required("--output")),
      `${JSON.stringify(result, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: true,
      output: resolve(required("--output")),
      minimumConfidence: result.minimumConfidence,
      objective: result.objective,
      candidatesEvaluated: result.candidatesEvaluated,
    }, null, 2));
    return;
  }
  if (command === "apply-luna-confidence") {
    const document = JSON.parse(
      await readFile(resolve(required("--thresholds")), "utf8"),
    ) as { minimumConfidence: number };
    const predictions = applyLunaConfidenceThreshold(
      await readJsonl<import("./types.ts").ClassifierPredictionV1>(
        resolve(required("--predictions")),
      ),
      document.minimumConfidence,
    );
    await writeJsonlPrivate(resolve(required("--output")), predictions);
    console.log(JSON.stringify({
      ok: true,
      output: resolve(required("--output")),
      minimumConfidence: document.minimumConfidence,
      predictions: predictions.length,
    }, null, 2));
    return;
  }
  if (command === "classify-embeddings") {
    const cards = await readJsonl<AreaCardV1>(resolve(required("--areas")));
    const vectors = JSON.parse(await readFile(resolve(required("--vectors")), "utf8")) as SavedVectorArtifact;
    const representation = required("--representation");
    if (representation !== TASK_CONTEXT_REPRESENTATION) throw new Error(`Invalid --representation; only ${TASK_CONTEXT_REPRESENTATION} is supported`);
    const tasks = vectors.taskVectors.filter((vector) => vector.representation === representation);
    const areas = has("--strict-hidden-registry")
      ? buildHiddenAreaVectors(cards, vectors)
      : buildAreaVectors(cards, vectors);
    const thresholdsFile = value("--thresholds");
    const thresholdsDocument = thresholdsFile
      ? JSON.parse(await readFile(resolve(thresholdsFile), "utf8")) as import("./types.ts").ThresholdsV1 | { thresholds: import("./types.ts").ThresholdsV1 }
      : undefined;
    const thresholds = thresholdsDocument
      ? ("thresholds" in thresholdsDocument ? thresholdsDocument.thresholds : thresholdsDocument)
      : { minimumTopScore: -1, minimumMargin: 0, minimumSecondScoreForMultiArea: 2, maximumSelectedAreas: 2 as const };
    const predictions = classifyAllEmbeddingMethods(tasks, areas, thresholds);
    const outputDirectory = resolve(required("--output-directory"));
    for (const [method, values] of Object.entries(predictions)) await writeJsonlPrivate(`${outputDirectory}/${representation}-${method}.jsonl`, values);
    console.log(JSON.stringify({ ok: true, outputDirectory, representation, tasks: tasks.length, methods: Object.keys(predictions) }, null, 2));
    return;
  }
  if (command === "plan-embedding" || command === "embed-dataset") {
    const execute = command === "embed-dataset";
    if (execute && !has("--confirm-external-run")) throw new Error("Refusing hosted calls without --confirm-external-run");
    const profile = JSON.parse(await readFile(resolve(required("--profile")), "utf8")) as RepositoryProfileV1;
    const cards = await readJsonl<AreaCardV1>(resolve(required("--areas")));
    const episodes = await readJsonl<TaskEpisode>(resolve(required("--episodes")));
    validateRepositoryProfile(profile); validateAreaCards(cards, profile); validateEpisodes(episodes, cards);
    const inputs = buildRepresentationEmbeddingInputs(profile, cards, episodes);
    const model = required("--model"); const totalInputs = inputs.tasks.length + inputs.overviews.length + inputs.examples.length;
    const price = (await fetchEmbeddingModelPrices()).get(model); if (!price) throw new Error(`Model not in OpenRouter embedding catalog: ${model}`);
    const estimatedInputTokens = [...inputs.tasks, ...inputs.overviews, ...inputs.examples].reduce((sum, input) => sum + estimateTokens(input.text), 0);
    const projectedMaximum = maximumCallCost(price, estimatedInputTokens, 0);
    const reservation = Number(value("--maximum-cost-usd") ?? String(projectedMaximum));
    if (reservation + 1e-9 < projectedMaximum) throw new Error(`--maximum-cost-usd $${reservation} is below projected maximum $${projectedMaximum}`);
    const plan = { plan: true, dryRun: !execute, hostedProvider: "OpenRouter", model, inputs: totalInputs, estimatedInputTokens, projectedMaximumCostUsd: projectedMaximum, reservedMaximumCostUsd: reservation, privateFieldsLeavingMachine: ["validation/test task envelopes", "Area Card overviews", "reference task text"], executionRequires: "--confirm-external-run" };
    console.log(JSON.stringify(plan, null, 2));
    if (!execute) return;
    const artifactsRoot = resolve(required("--artifacts"));
    const directory = await createRunDirectory(artifactsRoot, required("--run-id"));
    const ledger = new BudgetLedger(`${artifactsRoot}/global-budget.json`, EXPERIMENT_BUDGET_CEILING_USD);
    await ledger.reserve(reservation);
    let before: Awaited<ReturnType<typeof getOpenRouterKeyStatus>> | undefined;
    let hostedStarted = false;
    let settled = false;
    try {
      before = await getOpenRouterKeyStatus();
      if (before.limitRemainingUsd !== null && before.limitRemainingUsd < reservation) throw new Error("OpenRouter key limit is below the requested reservation");
      await writeImmutable(`${directory}/manifest.lock.json`, { schemaVersion: 1, runId: required("--run-id"), command: "embed-dataset", model, inputCount: totalInputs, maximumCostUsd: reservation, repositoryId: profile.repositoryId, repositorySnapshot: profile.snapshot });
      hostedStarted = true;
      const embedded = await embedRepresentationInputs(model, new EmbeddingCache(resolve(required("--cache"))), inputs);
      const after = await getOpenRouterKeyStatus();
      const providerMeteredCostUsd = Math.max(
        0,
        (after.accountUsageUsd ?? after.usageUsd) -
          (before.accountUsageUsd ?? before.usageUsd),
      );
      const apiEquivalentCostUsd = maximumCallCost(
        price,
        embedded.usageTokens ?? 0,
        0,
      );
      const actual = Math.max(providerMeteredCostUsd, apiEquivalentCostUsd);
      const artifact: SavedVectorArtifact = { schemaVersion: 1, embeddingModel: model, serializationVersion: "task-envelope-v1", taskVectors: embedded.taskVectors, overviewVectors: embedded.overviewVectors, exampleVectors: embedded.exampleVectors };
      await writeFile(resolve(required("--output")), `${JSON.stringify(artifact)}\n`, { mode: 0o600, flag: "wx" });
      await writeImmutable(`${directory}/cost.json`, {
        maximumCostUsd: reservation,
        actualCostUsd: actual,
        providerMeteredCostUsd,
        apiEquivalentCostUsd,
        hostedInputs: embedded.hostedInputs,
        cachedInputs: embedded.cachedInputs,
        usageTokens: embedded.usageTokens ?? null,
      });
      await ledger.settle(reservation, actual);
      settled = true;
      console.log(JSON.stringify({ ok: true, output: resolve(required("--output")), actualCostUsd: actual, hostedInputs: embedded.hostedInputs, cachedInputs: embedded.cachedInputs, usageTokens: embedded.usageTokens ?? null, taskVectors: embedded.taskVectors.length, overviewVectors: embedded.overviewVectors.length, exampleVectors: embedded.exampleVectors.length }, null, 2));
    } catch (error) {
      if (!settled) {
        try {
          if (!hostedStarted || !before) {
            await ledger.release(reservation);
          } else {
            const after = await getOpenRouterKeyStatus();
            const providerMeteredCostUsd = Math.max(
              0,
              (after.accountUsageUsd ?? after.usageUsd) -
                (before.accountUsageUsd ?? before.usageUsd),
            );
            await writeImmutable(`${directory}/partial-cost.json`, {
              maximumCostUsd: reservation,
              actualCostUsd: providerMeteredCostUsd,
              providerMeteredCostUsd,
              apiEquivalentCostUsd: null,
              note: "Embedding usage was not returned before the interrupted run; provider-metered delta is the available lower bound.",
            });
            await ledger.settle(reservation, providerMeteredCostUsd);
          }
          settled = true;
        } catch {}
      }
      throw error;
    }
    return;
  }
  if (command === "plan-luna" || command === "run-luna") {
    const execute = command === "run-luna";
    if (execute && !has("--confirm-external-run")) throw new Error("Refusing hosted calls without --confirm-external-run");
    const profile = JSON.parse(await readFile(resolve(required("--profile")), "utf8")) as RepositoryProfileV1;
    const cards = await readJsonl<AreaCardV1>(resolve(required("--areas")));
    const episodes = (await readJsonl<TaskEpisode>(resolve(required("--episodes")))).filter((episode) => episode.split !== "reference");
    validateRepositoryProfile(profile); validateAreaCards(cards, profile); validateEpisodes(episodes);
    const representation = required("--representation");
    if (representation !== TASK_CONTEXT_REPRESENTATION) throw new Error(`Invalid --representation; only ${TASK_CONTEXT_REPRESENTATION} is supported`);
    const model = required("--model");
    const maxOutputTokens = Number(value("--max-output-tokens") ?? "400");
    const price = (await fetchModelPrices()).get(model); if (!price) throw new Error(`Model not in OpenRouter catalog: ${model}`);
    const renderedCards = renderLunaAreaCards(cards);
    const estimatedInputTokens = episodes.reduce((sum, episode) => sum + estimateTokens(serializeRepresentation(episode, profile, representation)) + estimateTokens(renderedCards) + 150, 0);
    const projectedMaximum = maximumCallCost(price, estimatedInputTokens, episodes.length * maxOutputTokens);
    const reservation = Number(value("--maximum-cost-usd") ?? String(projectedMaximum));
    if (reservation + 1e-9 < projectedMaximum) throw new Error(`--maximum-cost-usd $${reservation} is below projected maximum $${projectedMaximum}`);
    console.log(JSON.stringify({ plan: true, dryRun: !execute, hostedProvider: "OpenRouter", model, calls: episodes.length, estimatedInputTokens, reservedOutputTokens: episodes.length * maxOutputTokens, projectedMaximumCostUsd: projectedMaximum, privateFieldsLeavingMachine: ["selected task representation", "complete Area Cards"], maximumCostUsd: reservation, executionRequires: "--confirm-external-run" }, null, 2));
    if (!execute) return;
    const artifactsRoot = resolve(required("--artifacts"));
    const directory = await createRunDirectory(artifactsRoot, required("--run-id"));
    const ledger = new BudgetLedger(`${artifactsRoot}/global-budget.json`, EXPERIMENT_BUDGET_CEILING_USD);
    await ledger.reserve(reservation);
    let before: Awaited<ReturnType<typeof getOpenRouterKeyStatus>> | undefined;
    let hostedStarted = false;
    const predictions: import("./types.ts").ClassifierPredictionV1[] = [];
    let settled = false;
    try {
      before = await getOpenRouterKeyStatus();
      if (
        before.limitRemainingUsd !== null &&
        before.limitRemainingUsd + 1e-9 < reservation
      ) {
        throw new Error(
          `OpenRouter key has only $${before.limitRemainingUsd.toFixed(6)} remaining; reservation requires $${reservation.toFixed(6)}`,
        );
      }
      await writeImmutable(`${directory}/manifest.lock.json`, { schemaVersion: 1, runId: required("--run-id"), command: "run-luna", model, representation, calls: episodes.length, maximumCostUsd: reservation, repositoryId: profile.repositoryId, repositorySnapshot: profile.snapshot });
      for (const episode of episodes) {
        hostedStarted = true;
        predictions.push(await classifyWithLuna({
          taskEpisodeId: episode.id, model, taskEnvelope: serializeRepresentation(episode, profile, representation),
          areaCards: renderedCards, allowedAreaIds: cards.map((card) => card.areaId), maxOutputTokens,
        }));
      }
      const after = await getOpenRouterKeyStatus();
      const providerMeteredCostUsd = Math.max(
        0,
        (after.accountUsageUsd ?? after.usageUsd) -
          (before.accountUsageUsd ?? before.usageUsd),
      );
      const reportedCosts = predictions
        .map((prediction) => prediction.costUsd)
        .filter((cost): cost is number => cost !== undefined);
      const apiEquivalentCostUsd = reportedCosts.length === predictions.length
        ? reportedCosts.reduce((sum, cost) => sum + cost, 0)
        : maximumCallCost(
            price,
            predictions.reduce(
              (sum, prediction) => sum + (prediction.inputTokens ?? 0),
              0,
            ),
            predictions.reduce(
              (sum, prediction) => sum + (prediction.outputTokens ?? 0),
              0,
            ),
          );
      const actual = Math.max(providerMeteredCostUsd, apiEquivalentCostUsd);
      await writeJsonlPrivate(resolve(required("--output")), predictions);
      await writeImmutable(`${directory}/cost.json`, {
        maximumCostUsd: reservation,
        actualCostUsd: actual,
        providerMeteredCostUsd,
        apiEquivalentCostUsd,
        calls: predictions.length,
        inputTokens: predictions.reduce(
          (sum, prediction) => sum + (prediction.inputTokens ?? 0),
          0,
        ),
        outputTokens: predictions.reduce(
          (sum, prediction) => sum + (prediction.outputTokens ?? 0),
          0,
        ),
      });
      await ledger.settle(reservation, actual);
      settled = true;
      console.log(JSON.stringify({ ok: true, output: resolve(required("--output")), predictions: predictions.length, actualCostUsd: actual }, null, 2));
    } catch (error) {
      await writeJsonlPrivate(`${directory}/private/partial-luna-predictions.jsonl`, predictions);
      if (!settled) {
        try {
          if (!hostedStarted || !before) {
            await ledger.release(reservation);
          } else {
            const after = await getOpenRouterKeyStatus();
            const providerMeteredCostUsd = Math.max(
              0,
              (after.accountUsageUsd ?? after.usageUsd) -
                (before.accountUsageUsd ?? before.usageUsd),
            );
            const reportedCosts = predictions
              .map((prediction) => prediction.costUsd)
              .filter((cost): cost is number => cost !== undefined);
            const apiEquivalentCostUsd = reportedCosts.length === predictions.length
              ? reportedCosts.reduce((sum, cost) => sum + cost, 0)
              : maximumCallCost(
                  price,
                  predictions.reduce(
                    (sum, prediction) => sum + (prediction.inputTokens ?? 0),
                    0,
                  ),
                  predictions.reduce(
                    (sum, prediction) => sum + (prediction.outputTokens ?? 0),
                    0,
                  ),
                );
            const actualCostUsd = Math.max(
              providerMeteredCostUsd,
              apiEquivalentCostUsd,
            );
            await writeImmutable(`${directory}/partial-cost.json`, {
              maximumCostUsd: reservation,
              actualCostUsd,
              providerMeteredCostUsd,
              apiEquivalentCostUsd,
              completedCalls: predictions.length,
              inputTokens: predictions.reduce(
                (sum, prediction) => sum + (prediction.inputTokens ?? 0),
                0,
              ),
              outputTokens: predictions.reduce(
                (sum, prediction) => sum + (prediction.outputTokens ?? 0),
                0,
              ),
            });
            await ledger.settle(reservation, actualCostUsd);
          }
          settled = true;
        } catch {}
      }
      throw error;
    }
    return;
  }
  if (command === "select-luna-canary") {
    const selected = selectStratifiedLunaCanary(
      await readJsonl<TaskEpisode>(resolve(required("--episodes"))),
      await readJsonl<SilverLabelV1>(resolve(required("--labels"))),
      Number(value("--maximum-cases") ?? "10"),
    );
    await writeJsonlPrivate(resolve(required("--output")), selected);
    console.log(JSON.stringify({
      ok: true,
      output: resolve(required("--output")),
      episodes: selected.length,
      split: Object.fromEntries(
        ["validation", "test"].map((split) => [
          split,
          selected.filter((episode) => episode.split === split).length,
        ]),
      ),
      contextual: selected.filter((episode) =>
        Boolean(
          episode.taskAnchor ||
          episode.precedingAssistant ||
          episode.earlierUserContext?.length ||
          episode.relevantDiagnostic,
        ),
      ).length,
    }, null, 2));
    return;
  }
  if (
    command === "plan-luna-benchmark" ||
    command === "run-luna-benchmark"
  ) {
    const execute = command === "run-luna-benchmark";
    if (execute && !has("--confirm-external-run")) {
      throw new Error(
        "Refusing hosted calls without --confirm-external-run",
      );
    }
    const profile = JSON.parse(
      await readFile(resolve(required("--profile")), "utf8"),
    ) as RepositoryProfileV1;
    const cards = await readJsonl<AreaCardV1>(
      resolve(required("--areas")),
    );
    const episodes = (
      await readJsonl<TaskEpisode>(resolve(required("--episodes")))
    ).filter((episode) => episode.split !== "reference");
    const matrix = JSON.parse(
      await readFile(resolve(required("--matrix")), "utf8"),
    ) as LunaBenchmarkMatrix;
    validateRepositoryProfile(profile);
    validateAreaCards(cards, profile);
    validateEpisodes(episodes);
    validateLunaBenchmarkMatrix(matrix);
    const model = required("--model");
    const price = (await fetchModelPrices()).get(model);
    if (!price) throw new Error(`Model not in OpenRouter catalog: ${model}`);
    const planVariants = matrix.variants.map((variant) => {
      const areaContext = renderLunaAreaContext(cards, variant.areaContext);
      const calls = episodes.length * (variant.repetitions ?? 1);
      const estimatedInputTokensPerPass = episodes.reduce(
        (sum, episode) =>
          sum +
          estimateTokens(
            serializeLunaTaskContext(
              episode,
              profile,
              variant.taskContext,
            ),
          ) +
          estimateTokens(areaContext) +
          300,
        0,
      );
      const estimatedInputTokens =
        estimatedInputTokensPerPass * (variant.repetitions ?? 1);
      const reservedOutputTokens = calls * variant.maxOutputTokens;
      return {
        id: variant.id,
        calls,
        estimatedInputTokens,
        reservedOutputTokens,
        projectedMaximumCostUsd: maximumCallCost(
          price,
          estimatedInputTokens,
          reservedOutputTokens,
        ),
        configuration: variant,
      };
    });
    const projectedMaximum = planVariants.reduce(
      (sum, variant) => sum + variant.projectedMaximumCostUsd,
      0,
    );
    const reservation = Number(
      value("--maximum-cost-usd") ?? String(projectedMaximum),
    );
    if (reservation + 1e-9 < projectedMaximum) {
      throw new Error(
        `--maximum-cost-usd $${reservation} is below projected maximum $${projectedMaximum}`,
      );
    }
    console.log(JSON.stringify({
      plan: true,
      dryRun: !execute,
      hostedProvider: "OpenRouter",
      model,
      episodes: episodes.length,
      variants: planVariants,
      calls: planVariants.reduce((sum, variant) => sum + variant.calls, 0),
      projectedMaximumCostUsd: projectedMaximum,
      maximumCostUsd: reservation,
      hardExperimentBudgetCeilingUsd: EXPERIMENT_BUDGET_CEILING_USD,
      privateFieldsLeavingMachine: [
        "task-aware context packages",
        "configured Area Registry representations",
      ],
      latestRequestOnlySupported: false,
      executionRequires: "--confirm-external-run",
    }, null, 2));
    if (!execute) return;
    const labels = await readJsonl<SilverLabelV1>(
      resolve(required("--labels")),
    );
    validateBenchmarkDataset(profile, cards, episodes, labels);
    const artifactsRoot = resolve(required("--artifacts"));
    const runId = required("--run-id");
    const directory = await createRunDirectory(artifactsRoot, runId);
    const ledger = new BudgetLedger(
      `${artifactsRoot}/global-budget.json`,
      EXPERIMENT_BUDGET_CEILING_USD,
    );
    await ledger.reserve(reservation);
    let before: Awaited<ReturnType<typeof getOpenRouterKeyStatus>> | undefined;
    let hostedStarted = false;
    let settled = false;
    const predictionsByVariant: Record<
      string,
      import("./types.ts").ClassifierPredictionV1[]
    > = Object.fromEntries(
      matrix.variants.map((variant) => [variant.id, []]),
    );
    try {
      before = await getOpenRouterKeyStatus();
      if (
        before.limitRemainingUsd !== null &&
        before.limitRemainingUsd + 1e-9 < reservation
      ) {
        throw new Error(
          `OpenRouter key has only $${before.limitRemainingUsd.toFixed(6)} remaining; reservation requires $${reservation.toFixed(6)}`,
        );
      }
      await writeImmutable(`${directory}/manifest.lock.json`, {
        schemaVersion: 1,
        runId,
        command: "run-luna-benchmark",
        model,
        variants: planVariants,
        maximumCostUsd: reservation,
        repositoryId: profile.repositoryId,
        repositorySnapshot: profile.snapshot,
        episodeIds: episodes.map((episode) => episode.id),
        latestRequestOnlySupported: false,
      });
      for (const variant of matrix.variants) {
        const areaContext = renderLunaAreaContext(
          cards,
          variant.areaContext,
        );
        for (
          let repetition = 0;
          repetition < (variant.repetitions ?? 1);
          repetition += 1
        ) {
          for (const episode of episodes) {
            hostedStarted = true;
            predictionsByVariant[variant.id]!.push(
              await classifyWithLuna({
                taskEpisodeId: episode.id,
                model,
                taskEnvelope: serializeLunaTaskContext(
                  episode,
                  profile,
                  variant.taskContext,
                ),
                areaCards: areaContext,
                allowedAreaIds: cards.map((card) => card.areaId),
                maxOutputTokens: variant.maxOutputTokens,
                promptOrder: variant.promptOrder,
                decisionMode: variant.decisionMode,
                outputMode: variant.outputMode,
                reasoningEffort: variant.reasoningEffort,
                classifierLabel: `llm:${model}:benchmark:${variant.id}:repeat-${repetition + 1}`,
              }),
            );
          }
        }
        await writeJsonlPrivate(
          `${directory}/private/${variant.id}.jsonl`,
          predictionsByVariant[variant.id]!,
        );
      }
      const allPredictions = Object.values(predictionsByVariant).flat();
      const after = await getOpenRouterKeyStatus();
      const providerMeteredCostUsd = Math.max(
        0,
        (after.accountUsageUsd ?? after.usageUsd) -
          (before.accountUsageUsd ?? before.usageUsd),
      );
      const reportedCosts = allPredictions
        .map((prediction) => prediction.costUsd)
        .filter((cost): cost is number => cost !== undefined);
      const apiEquivalentCostUsd =
        reportedCosts.length === allPredictions.length
          ? reportedCosts.reduce((sum, cost) => sum + cost, 0)
          : maximumCallCost(
              price,
              allPredictions.reduce(
                (sum, prediction) =>
                  sum + (prediction.inputTokens ?? 0),
                0,
              ),
              allPredictions.reduce(
                (sum, prediction) =>
                  sum + (prediction.outputTokens ?? 0),
                0,
              ),
            );
      const actualCostUsd = Math.max(
        providerMeteredCostUsd,
        apiEquivalentCostUsd,
      );
      const report = buildLunaBenchmarkReport(
        model,
        matrix,
        labels,
        predictionsByVariant,
      );
      const representativeByVariant = Object.fromEntries(
        Object.entries(predictionsByVariant).map(([variant, values]) => [
          variant,
          representativeLunaPredictions(values),
        ]),
      );
      const sliceReport = buildSliceReport(
        episodes,
        labels.filter((label) =>
          episodes.some((episode) => episode.id === label.taskEpisodeId),
        ),
        representativeByVariant,
      );
      const repeatedPredictions = Object.fromEntries(
        matrix.variants
          .filter((variant) => (variant.repetitions ?? 1) > 1)
          .map((variant) => [
            variant.id,
            predictionsByVariant[variant.id]!,
          ]),
      );
      await writeImmutable(`${directory}/metrics/benchmark.json`, report);
      await writeImmutable(`${directory}/metrics/slices.json`, sliceReport);
      if (Object.keys(repeatedPredictions).length) {
        await writeImmutable(
          `${directory}/metrics/ensembles.json`,
          buildLunaEnsembleReport(
            labels.filter((label) =>
              episodes.some(
                (episode) => episode.id === label.taskEpisodeId,
              ),
            ),
            repeatedPredictions,
          ),
        );
      }
      await writeImmutable(`${directory}/cost.json`, {
        maximumCostUsd: reservation,
        actualCostUsd,
        providerMeteredCostUsd,
        apiEquivalentCostUsd,
        calls: allPredictions.length,
        inputTokens: allPredictions.reduce(
          (sum, prediction) => sum + (prediction.inputTokens ?? 0),
          0,
        ),
        cachedInputTokens: allPredictions.reduce(
          (sum, prediction) =>
            sum + (prediction.cachedInputTokens ?? 0),
          0,
        ),
        outputTokens: allPredictions.reduce(
          (sum, prediction) => sum + (prediction.outputTokens ?? 0),
          0,
        ),
        reasoningOutputTokens: allPredictions.reduce(
          (sum, prediction) =>
            sum + (prediction.reasoningOutputTokens ?? 0),
          0,
        ),
      });
      await ledger.settle(reservation, actualCostUsd);
      settled = true;
      console.log(JSON.stringify({
        ok: true,
        directory,
        report: `${directory}/metrics/benchmark.json`,
        variants: report.variants.map((variant) => ({
          id: variant.variant.id,
          calls: variant.calls,
          falseKnownRate: variant.metrics.core.falseKnownRate,
          topTwoRecall: variant.metrics.core.topTwoRecall,
          coverage: variant.metrics.routingCoverage,
          p50Ms: variant.metrics.latencyMs.p50,
          p95Ms: variant.metrics.latencyMs.p95,
          costPerCaseUsd: variant.metrics.costUsd.perCase,
        })),
        actualCostUsd,
      }, null, 2));
    } catch (error) {
      for (const [variant, predictions] of Object.entries(
        predictionsByVariant,
      )) {
        if (predictions.length) {
          await writeJsonlPrivate(
            `${directory}/private/partial-${variant}.jsonl`,
            predictions,
          );
        }
      }
      if (!settled) {
        try {
          if (!hostedStarted || !before) {
            await ledger.release(reservation);
          } else {
            const after = await getOpenRouterKeyStatus();
            const allPredictions = Object.values(
              predictionsByVariant,
            ).flat();
            const providerMeteredCostUsd = Math.max(
              0,
              (after.accountUsageUsd ?? after.usageUsd) -
                (before.accountUsageUsd ?? before.usageUsd),
            );
            const reportedCosts = allPredictions
              .map((prediction) => prediction.costUsd)
              .filter((cost): cost is number => cost !== undefined);
            const apiEquivalentCostUsd = reportedCosts.reduce(
              (sum, cost) => sum + cost,
              0,
            );
            const actualCostUsd = Math.max(
              providerMeteredCostUsd,
              apiEquivalentCostUsd,
            );
            await writeImmutable(`${directory}/partial-cost.json`, {
              maximumCostUsd: reservation,
              actualCostUsd,
              providerMeteredCostUsd,
              apiEquivalentCostUsd,
              completedCalls: allPredictions.length,
            });
            await ledger.settle(reservation, actualCostUsd);
          }
          settled = true;
        } catch {}
      }
      throw error;
    }
    return;
  }
  if (command === "analyze-luna-benchmark") {
    const matrix = JSON.parse(
      await readFile(resolve(required("--matrix")), "utf8"),
    ) as LunaBenchmarkMatrix;
    validateLunaBenchmarkMatrix(matrix);
    const predictionSpecs = args.flatMap((arg, index) =>
      arg === "--prediction" && args[index + 1]
        ? [args[index + 1]!]
        : [],
    );
    const predictions: Record<
      string,
      import("./types.ts").ClassifierPredictionV1[]
    > = {};
    for (const spec of predictionSpecs) {
      const separator = spec.indexOf("=");
      if (separator < 1) {
        throw new Error("--prediction must be VARIANT=FILE");
      }
      predictions[spec.slice(0, separator)] = await readJsonl(
        resolve(spec.slice(separator + 1)),
      );
    }
    for (const variant of matrix.variants) {
      if (!predictions[variant.id]) {
        throw new Error(`Missing predictions for ${variant.id}`);
      }
    }
    const labels = await readJsonl<SilverLabelV1>(
      resolve(required("--labels")),
    );
    const report = buildLunaBenchmarkReport(
      required("--model"),
      matrix,
      labels,
      predictions,
    );
    await writeFile(
      resolve(required("--output")),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: true,
      output: resolve(required("--output")),
      recommendations: report.recommendations,
      variants: report.variants.length,
      representativePredictions: Object.fromEntries(
        Object.entries(predictions).map(([variant, values]) => [
          variant,
          representativeLunaPredictions(values).length,
        ]),
      ),
    }, null, 2));
    return;
  }
  if (
    command === "plan-luna-cascade" ||
    command === "run-luna-cascade"
  ) {
    const execute = command === "run-luna-cascade";
    if (execute && !has("--confirm-external-run")) {
      throw new Error(
        "Refusing hosted calls without --confirm-external-run",
      );
    }
    const profile = JSON.parse(
      await readFile(resolve(required("--profile")), "utf8"),
    ) as RepositoryProfileV1;
    const cards = await readJsonl<AreaCardV1>(
      resolve(required("--areas")),
    );
    const episodes = (
      await readJsonl<TaskEpisode>(resolve(required("--episodes")))
    ).filter((episode) => episode.split !== "reference");
    const matrix = JSON.parse(
      await readFile(resolve(required("--matrix")), "utf8"),
    ) as LunaCascadeMatrix;
    validateRepositoryProfile(profile);
    validateAreaCards(cards, profile);
    validateEpisodes(episodes);
    validateLunaCascadeMatrix(matrix);
    const model = required("--model");
    const price = (await fetchModelPrices()).get(model);
    if (!price) throw new Error(`Model not in OpenRouter catalog: ${model}`);
    const planVariants = matrix.variants.map((variant) => {
      const areaContext = renderLunaAreaContext(
        cards,
        variant.areaContext,
      );
      const gateInputTokens = episodes.reduce(
        (sum, episode) =>
          sum +
          estimateTokens(
            serializeLunaTaskContext(
              episode,
              profile,
              variant.gateTaskContext,
            ),
          ) +
          220,
        0,
      );
      const areaInputTokens = episodes.reduce(
        (sum, episode) =>
          sum +
          estimateTokens(
            serializeLunaTaskContext(
              episode,
              profile,
              variant.areaTaskContext,
            ),
          ) +
          estimateTokens(areaContext) +
          300,
        0,
      );
      const maximumGateCostUsd = maximumCallCost(
        price,
        gateInputTokens,
        episodes.length * variant.gateMaxOutputTokens,
      );
      const maximumAreaCostUsd = maximumCallCost(
        price,
        areaInputTokens,
        episodes.length * variant.areaMaxOutputTokens,
      );
      return {
        id: variant.id,
        maximumCalls: episodes.length * 2,
        maximumGateCostUsd,
        maximumAreaCostUsd,
        projectedMaximumCostUsd:
          maximumGateCostUsd + maximumAreaCostUsd,
        configuration: variant,
      };
    });
    const projectedMaximum = planVariants.reduce(
      (sum, variant) => sum + variant.projectedMaximumCostUsd,
      0,
    );
    const reservation = Number(
      value("--maximum-cost-usd") ?? String(projectedMaximum),
    );
    if (reservation + 1e-9 < projectedMaximum) {
      throw new Error(
        `--maximum-cost-usd $${reservation} is below projected maximum $${projectedMaximum}`,
      );
    }
    console.log(JSON.stringify({
      plan: true,
      dryRun: !execute,
      hostedProvider: "OpenRouter",
      model,
      episodes: episodes.length,
      variants: planVariants,
      projectedMaximumCostUsd: projectedMaximum,
      maximumCostUsd: reservation,
      latestRequestOnlySupported: false,
      executionRequires: "--confirm-external-run",
    }, null, 2));
    if (!execute) return;
    const labels = await readJsonl<SilverLabelV1>(
      resolve(required("--labels")),
    );
    const relevantLabels = labels.filter((label) =>
      episodes.some((episode) => episode.id === label.taskEpisodeId),
    );
    if (relevantLabels.length !== episodes.length) {
      throw new Error("Every Luna cascade episode must have one label");
    }
    const artifactsRoot = resolve(required("--artifacts"));
    const runId = required("--run-id");
    const directory = await createRunDirectory(artifactsRoot, runId);
    const ledger = new BudgetLedger(
      `${artifactsRoot}/global-budget.json`,
      EXPERIMENT_BUDGET_CEILING_USD,
    );
    await ledger.reserve(reservation);
    let before: Awaited<ReturnType<typeof getOpenRouterKeyStatus>> | undefined;
    let hostedStarted = false;
    let settled = false;
    const gatesByVariant: Record<
      string,
      LunaTaskKindPredictionV1[]
    > = Object.fromEntries(
      matrix.variants.map((variant) => [variant.id, []]),
    );
    const areasByVariant: Record<
      string,
      import("./types.ts").ClassifierPredictionV1[]
    > = Object.fromEntries(
      matrix.variants.map((variant) => [variant.id, []]),
    );
    const finalByVariant: Record<
      string,
      import("./types.ts").ClassifierPredictionV1[]
    > = Object.fromEntries(
      matrix.variants.map((variant) => [variant.id, []]),
    );
    try {
      before = await getOpenRouterKeyStatus();
      if (
        before.limitRemainingUsd !== null &&
        before.limitRemainingUsd + 1e-9 < reservation
      ) {
        throw new Error(
          `OpenRouter key has only $${before.limitRemainingUsd.toFixed(6)} remaining; reservation requires $${reservation.toFixed(6)}`,
        );
      }
      await writeImmutable(`${directory}/manifest.lock.json`, {
        schemaVersion: 1,
        runId,
        command: "run-luna-cascade",
        model,
        variants: planVariants,
        maximumCostUsd: reservation,
        repositoryId: profile.repositoryId,
        repositorySnapshot: profile.snapshot,
        episodeIds: episodes.map((episode) => episode.id),
        latestRequestOnlySupported: false,
      });
      for (const variant of matrix.variants) {
        const areaContext = renderLunaAreaContext(
          cards,
          variant.areaContext,
        );
        for (const episode of episodes) {
          hostedStarted = true;
          const gate = await classifyTaskKindWithLuna({
            taskEpisodeId: episode.id,
            model,
            taskEnvelope: serializeLunaTaskContext(
              episode,
              profile,
              variant.gateTaskContext,
            ),
            reasoningEffort: variant.gateReasoningEffort,
            maxOutputTokens: variant.gateMaxOutputTokens,
            classifierLabel: `llm:${model}:cascade:${variant.id}:gate`,
          });
          gatesByVariant[variant.id]!.push(gate);
          let area:
            | import("./types.ts").ClassifierPredictionV1
            | undefined;
          if (gate.taskKind === "repository_task") {
            area = await classifyWithLuna({
              taskEpisodeId: episode.id,
              model,
              taskEnvelope: serializeLunaTaskContext(
                episode,
                profile,
                variant.areaTaskContext,
              ),
              areaCards: areaContext,
              allowedAreaIds: cards.map((card) => card.areaId),
              maxOutputTokens: variant.areaMaxOutputTokens,
              promptOrder: variant.areaPromptOrder,
              decisionMode: variant.areaDecisionMode,
              outputMode: variant.areaOutputMode,
              reasoningEffort: variant.areaReasoningEffort,
              classifierLabel: `llm:${model}:cascade:${variant.id}:area`,
            });
            areasByVariant[variant.id]!.push(area);
          }
          finalByVariant[variant.id]!.push(
            combineLunaCascadePrediction(gate, area, variant.id),
          );
        }
        await writeJsonlPrivate(
          `${directory}/private/${variant.id}-gates.jsonl`,
          gatesByVariant[variant.id]!,
        );
        await writeJsonlPrivate(
          `${directory}/private/${variant.id}-areas.jsonl`,
          areasByVariant[variant.id]!,
        );
        await writeJsonlPrivate(
          `${directory}/private/${variant.id}-final.jsonl`,
          finalByVariant[variant.id]!,
        );
      }
      const reports = Object.fromEntries(
        matrix.variants.map((variant) => [
          variant.id,
          buildLunaCascadeVariantReport(
            variant,
            relevantLabels,
            gatesByVariant[variant.id]!,
            areasByVariant[variant.id]!,
            finalByVariant[variant.id]!,
          ),
        ]),
      );
      const allGates = Object.values(gatesByVariant).flat();
      const allAreas = Object.values(areasByVariant).flat();
      const after = await getOpenRouterKeyStatus();
      const providerMeteredCostUsd = Math.max(
        0,
        (after.accountUsageUsd ?? after.usageUsd) -
          (before.accountUsageUsd ?? before.usageUsd),
      );
      const reportedCosts = [
        ...allGates.map((prediction) => prediction.costUsd),
        ...allAreas.map((prediction) => prediction.costUsd),
      ].filter((cost): cost is number => cost !== undefined);
      const apiEquivalentCostUsd = reportedCosts.reduce(
        (sum, cost) => sum + cost,
        0,
      );
      const actualCostUsd = Math.max(
        providerMeteredCostUsd,
        apiEquivalentCostUsd,
      );
      await writeImmutable(`${directory}/metrics/cascade.json`, {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        model,
        cases: relevantLabels.length,
        variants: reports,
        limitations: [
          "The cascade is measured on previously inspected development cases.",
          "Final latency is sequential gate latency plus conditional area-classifier latency.",
          "Every gate and area call uses task-aware repository context.",
        ],
      });
      await writeImmutable(`${directory}/metrics/slices.json`, buildSliceReport(
        episodes,
        relevantLabels,
        finalByVariant,
      ));
      await writeImmutable(`${directory}/cost.json`, {
        maximumCostUsd: reservation,
        actualCostUsd,
        providerMeteredCostUsd,
        apiEquivalentCostUsd,
        gateCalls: allGates.length,
        areaCalls: allAreas.length,
        totalCalls: allGates.length + allAreas.length,
      });
      await ledger.settle(reservation, actualCostUsd);
      settled = true;
      console.log(JSON.stringify({
        ok: true,
        directory,
        actualCostUsd,
        variants: Object.fromEntries(
          Object.entries(reports).map(([id, report]) => [
            id,
            {
              gateAccuracy: report.gate.accuracy,
              actionablePrecision: report.gate.actionablePrecision,
              actionableRecall: report.gate.actionableRecall,
              areaCalls: report.areaCalls,
              falseKnownRate: report.final.core.falseKnownRate,
              falseUnknownRate: report.final.core.falseUnknownRate,
              topTwoRecall: report.final.core.topTwoRecall,
              p50Ms: report.final.latencyMs.p50,
              p95Ms: report.final.latencyMs.p95,
              costPerCaseUsd: report.final.costUsd.perCase,
            },
          ]),
        ),
      }, null, 2));
    } catch (error) {
      for (const variant of matrix.variants) {
        if (gatesByVariant[variant.id]!.length) {
          await writeJsonlPrivate(
            `${directory}/private/partial-${variant.id}-gates.jsonl`,
            gatesByVariant[variant.id]!,
          );
        }
        if (areasByVariant[variant.id]!.length) {
          await writeJsonlPrivate(
            `${directory}/private/partial-${variant.id}-areas.jsonl`,
            areasByVariant[variant.id]!,
          );
        }
      }
      if (!settled) {
        try {
          if (!hostedStarted || !before) {
            await ledger.release(reservation);
          } else {
            const after = await getOpenRouterKeyStatus();
            const providerMeteredCostUsd = Math.max(
              0,
              (after.accountUsageUsd ?? after.usageUsd) -
                (before.accountUsageUsd ?? before.usageUsd),
            );
            const reportedCosts = [
              ...Object.values(gatesByVariant)
                .flat()
                .map((prediction) => prediction.costUsd),
              ...Object.values(areasByVariant)
                .flat()
                .map((prediction) => prediction.costUsd),
            ].filter((cost): cost is number => cost !== undefined);
            const apiEquivalentCostUsd = reportedCosts.reduce(
              (sum, cost) => sum + cost,
              0,
            );
            const actualCostUsd = Math.max(
              providerMeteredCostUsd,
              apiEquivalentCostUsd,
            );
            await writeImmutable(`${directory}/partial-cost.json`, {
              maximumCostUsd: reservation,
              actualCostUsd,
              providerMeteredCostUsd,
              apiEquivalentCostUsd,
              completedGateCalls: Object.values(gatesByVariant)
                .flat()
                .length,
              completedAreaCalls: Object.values(areasByVariant)
                .flat()
                .length,
            });
            await ledger.settle(reservation, actualCostUsd);
          }
          settled = true;
        } catch {}
      }
      throw error;
    }
    return;
  }
  if (command === "simulate-cascade") {
    const embedding = await readJsonl<import("./types.ts").ClassifierPredictionV1>(resolve(required("--embedding")));
    const luna = await readJsonl<import("./types.ts").ClassifierPredictionV1>(resolve(required("--luna")));
    const result = simulateCascade(embedding, luna);
    await writeJsonlPrivate(resolve(required("--output")), result.predictions);
    console.log(JSON.stringify({ ok: true, output: resolve(required("--output")), embeddingAccepted: result.embeddingAccepted, lunaUsed: result.lunaUsed, fallbackUsed: result.fallbackUsed }, null, 2));
    return;
  }
  if (command === "withhold-area") {
    const cards = await readJsonl<AreaCardV1>(resolve(required("--areas")));
    const labels = await readJsonl<SilverLabelV1>(resolve(required("--labels")));
    const result = withholdArea(cards, labels, required("--area-id")); const prefix = resolve(required("--output-prefix"));
    await writeJsonlPrivate(`${prefix}-areas.jsonl`, result.cards);
    await writeJsonlPrivate(`${prefix}-known-labels.jsonl`, result.knownLabels);
    await writeJsonlPrivate(`${prefix}-hidden-labels.jsonl`, result.hiddenLabels);
    console.log(JSON.stringify({ ok: true, withheldAreaId: result.withheldAreaId, cards: result.cards.length, knownCases: result.knownLabels.length, hiddenCases: result.hiddenLabels.length }, null, 2));
    return;
  }
  if (command === "simulate-refresh") {
    const fullCards = await readJsonl<AreaCardV1>(resolve(required("--full-areas")));
    const hiddenCards = await readJsonl<AreaCardV1>(resolve(required("--hidden-areas")));
    const vectors = JSON.parse(await readFile(resolve(required("--vectors")), "utf8")) as SavedVectorArtifact;
    const representation = required("--representation");
    if (representation !== TASK_CONTEXT_REPRESENTATION) throw new Error(`Invalid --representation; only ${TASK_CONTEXT_REPRESENTATION} is supported`);
    const thresholdsFile = value("--thresholds");
    const thresholdsDocument = thresholdsFile
      ? JSON.parse(await readFile(resolve(thresholdsFile), "utf8")) as import("./types.ts").ThresholdsV1 | { thresholds: import("./types.ts").ThresholdsV1 }
      : undefined;
    const thresholds = thresholdsDocument
      ? ("thresholds" in thresholdsDocument ? thresholdsDocument.thresholds : thresholdsDocument)
      : { minimumTopScore: -1, minimumMargin: 0, minimumSecondScoreForMultiArea: 2, maximumSelectedAreas: 2 as const };
    const result = simulateAreaRefresh(fullCards, hiddenCards, vectors, required("--area-id"), representation, thresholds);
    await writeFile(resolve(required("--output")), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, output: resolve(required("--output")), restoredAreaId: result.restoredAreaId, requiredHostedVectors: result.requiredHostedVectorIds.length, existingOverviewVectorsReused: result.existingOverviewVectorsReused, existingExampleVectorsReused: result.existingExampleVectorsReused, changedPredictions: result.changedPredictions ?? null }, null, 2));
    return;
  }
  if (command === "render-report") {
    const labels = await readJsonl<SilverLabelV1>(resolve(required("--labels")));
    const predictionSpecs = args.flatMap((arg, index) => arg === "--prediction" && args[index + 1] ? [args[index + 1]!] : []);
    const predictions: Record<string, import("./types.ts").ClassifierPredictionV1[]> = {};
    for (const spec of predictionSpecs) {
      const separator = spec.indexOf("="); if (separator < 1) throw new Error("--prediction must be NAME=FILE");
      predictions[spec.slice(0, separator)] = await readJsonl<import("./types.ts").ClassifierPredictionV1>(resolve(spec.slice(separator + 1)));
    }
    const repositoryIds = args.flatMap((arg, index) => arg === "--repository-id" && args[index + 1] ? [args[index + 1]!] : []);
    const report = renderClassificationReport({ runId: required("--run-id"), repositoryIds, labels, predictions });
    await writeFile(resolve(required("--output")), report);
    console.log(JSON.stringify({ ok: true, output: resolve(required("--output")), classifiers: Object.keys(predictions), cases: labels.length }, null, 2));
    return;
  }
  if (command === "report-groups") {
    const episodes = await readJsonl<TaskEpisode>(resolve(required("--episodes")));
    const labels = await readJsonl<SilverLabelV1>(resolve(required("--labels")));
    const predictions = await readJsonl<import("./types.ts").ClassifierPredictionV1>(resolve(required("--predictions")));
    const report = buildGroupedReport(episodes, labels, predictions);
    await writeFile(resolve(required("--output")), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, output: resolve(required("--output")), groups: report.groups.map((group) => ({ userIdHash: group.userIdHash, repositoryId: group.repositoryId, cases: group.cases })), warnings: report.warnings }, null, 2));
    return;
  }
  if (command === "report-slices") {
    const predictionSpecs = args.flatMap((arg, index) =>
      arg === "--prediction" && args[index + 1] ? [args[index + 1]!] : []
    );
    const predictions: Record<
      string,
      import("./types.ts").ClassifierPredictionV1[]
    > = {};
    for (const spec of predictionSpecs) {
      const separator = spec.indexOf("=");
      if (separator < 1) throw new Error("--prediction must be NAME=FILE");
      predictions[spec.slice(0, separator)] = await readJsonl<
        import("./types.ts").ClassifierPredictionV1
      >(resolve(spec.slice(separator + 1)));
    }
    const report = buildSliceReport(
      await readJsonl<TaskEpisode>(resolve(required("--episodes"))),
      await readJsonl<SilverLabelV1>(resolve(required("--labels"))),
      predictions,
    );
    await writeFile(
      resolve(required("--output")),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: true,
      output: resolve(required("--output")),
      slices: report.slices.map((slice) => ({
        slice: slice.slice,
        cases: slice.cases,
      })),
      warnings: report.warnings,
    }, null, 2));
    return;
  }
  if (command === "capture-environment") {
    const output = resolve(required("--output"));
    await writeFile(output, `${JSON.stringify(await captureEnvironment(), null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, output }, null, 2));
    return;
  }
  if (command === "generate-transfer-key") {
    await generateTransferKeyPair(resolve(required("--private-key")), resolve(required("--public-key")));
    console.log(JSON.stringify({ ok: true, privateKey: resolve(required("--private-key")), publicKey: resolve(required("--public-key")) }, null, 2));
    return;
  }
  if (command === "encrypt-transfer") {
    const inputs = args.flatMap((arg, index) => arg === "--input" && args[index + 1] ? [resolve(args[index + 1]!)] : []);
    await encryptTransfer(inputs, resolve(required("--public-key")), resolve(required("--output")));
    console.log(JSON.stringify({ ok: true, output: resolve(required("--output")), inputs: inputs.map((input) => input.split("/").at(-1)) }, null, 2));
    return;
  }
  if (command === "import-transfer") {
    const outputs = await importTransfer(resolve(required("--input")), resolve(required("--private-key")), resolve(required("--output-directory")));
    console.log(JSON.stringify({ ok: true, outputDirectory: resolve(required("--output-directory")), files: outputs.map((output) => output.split("/").at(-1)) }, null, 2));
    return;
  }
  if (command === "build-routekit-seed") {
    const result = await buildRouteKitSeed(resolve(required("--pulls")), resolve(required("--repository")));
    await writeRouteKitSeed(result, resolve(required("--public-output")), resolve(required("--private-output")));
    console.log(JSON.stringify({ ok: true, profile: result.profile.repositoryId, areas: result.cards.map((card) => ({ areaId: card.areaId, referenceExamples: card.positiveExampleIds.length })), episodes: result.episodes.length, splits: Object.fromEntries(["reference", "validation", "test"].map((split) => [split, result.episodes.filter((item) => item.split === split).length])) }, null, 2));
    return;
  }
  if (command === "build-reference-registry") {
    const supplementalEpisodesFile = value("--supplemental-episodes");
    const supplementalAssignmentsFile = value("--supplemental-assignments");
    if (Boolean(supplementalEpisodesFile) !== Boolean(supplementalAssignmentsFile)) {
      throw new Error("--supplemental-episodes and --supplemental-assignments must be provided together");
    }
    const result = await buildReferenceRegistry({
      repository: resolve(required("--repository")),
      episodes: await readJsonl<TaskEpisode>(resolve(required("--episodes"))),
      ...(supplementalEpisodesFile && supplementalAssignmentsFile
        ? {
            supplementalEpisodes: await readJsonl<TaskEpisode>(resolve(supplementalEpisodesFile)),
            supplementalAssignments: await readJsonl<{ taskEpisodeId: string; selectedAreaIds: string[] }>(resolve(supplementalAssignmentsFile)),
          }
        : {}),
    });
    await writeFile(resolve(required("--profile-output")), `${JSON.stringify(result.profile, null, 2)}\n`, { mode: 0o600 });
    await writeJsonlPrivate(resolve(required("--areas-output")), result.cards);
    await writeJsonlPrivate(resolve(required("--assignments-output")), result.assignments);
    if (value("--registry-episodes-output")) {
      await writeJsonlPrivate(resolve(value("--registry-episodes-output")!), result.registryEpisodes);
    }
    console.log(JSON.stringify({
      ok: true,
      repositoryId: result.profile.repositoryId,
      snapshot: result.profile.snapshot,
      referenceAssignments: result.assignments.length,
      excludedReferenceEpisodes: result.excludedReferenceEpisodes,
      areas: result.cards.map((card) => ({ areaId: card.areaId, referenceExamples: card.positiveExampleIds.length })),
      areasBelowMinimumExamples: result.areasBelowMinimumExamples,
    }, null, 2));
    return;
  }
  if (command === "prepare-accuracy-dataset") {
    const source = await readUnlockedEpisodeSplits(
      resolve(required("--episodes")),
    );
    const { reference, validation } = source;
    validateEpisodes([...reference, ...validation]);
    if (reference.length === 0 || validation.length === 0) {
      throw new Error(
        "Accuracy dataset requires non-empty reference and validation splits",
      );
    }
    await writeJsonlPrivate(
      resolve(required("--reference-output")),
      reference,
    );
    await writeJsonlPrivate(
      resolve(required("--validation-output")),
      validation,
    );
    const plan = buildValidationEscalationPlan([...reference, ...validation]);
    await writeFile(
      resolve(required("--validation-plan-output")),
      `${JSON.stringify(plan, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          referenceEpisodes: reference.length,
          validationEpisodes: validation.length,
          lockedTestEpisodes: source.lockedTestCount,
          mandatorySecondPassEpisodes:
            plan.mandatorySecondPassEpisodeIds.length,
          referenceOutput: resolve(required("--reference-output")),
          validationOutput: resolve(required("--validation-output")),
          validationPlanOutput: resolve(required("--validation-plan-output")),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "select-oracle-second-pass") {
    const episodes = await readJsonl<TaskEpisode>(
      resolve(required("--episodes")),
    );
    const plan = JSON.parse(
      await readFile(resolve(required("--validation-plan")), "utf8"),
    ) as ReturnType<typeof buildValidationEscalationPlan>;
    const selected = selectSecondPassEpisodes(
      episodes,
      await readJsonl<SilverLabelV1>(
        resolve(required("--first-pass-labels")),
      ),
      plan,
    );
    await writeJsonlPrivate(resolve(required("--output")), selected);
    console.log(
      JSON.stringify(
        {
          ok: true,
          secondPassEpisodes: selected.length,
          output: resolve(required("--output")),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "select-oracle-third-pass") {
    const selected = selectDisagreementEpisodes(
      await readJsonl<TaskEpisode>(resolve(required("--episodes"))),
      await readJsonl<SilverLabelV1>(
        resolve(required("--first-pass-labels")),
      ),
      await readJsonl<SilverLabelV1>(
        resolve(required("--second-pass-labels")),
      ),
    );
    await writeJsonlPrivate(resolve(required("--output")), selected);
    console.log(
      JSON.stringify(
        {
          ok: true,
          thirdPassEpisodes: selected.length,
          output: resolve(required("--output")),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "recover-oracle-passes") {
    const result = await recoverOraclePassesFromTraces({
      traceDirectory: resolve(required("--traces")),
      episodes: await readJsonl<TaskEpisode>(
        resolve(required("--episodes")),
      ),
      cards: await readJsonl<AreaCardV1>(resolve(required("--areas"))),
      model: required("--model"),
    });
    await writeJsonlPrivate(
      resolve(required("--passes-output")),
      result.labels,
    );
    await writeJsonlPrivate(
      resolve(required("--trace-sources-output")),
      result.traceSources,
    );
    await writeFile(
      resolve(required("--report-output")),
      `${JSON.stringify(result.summary, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify(
        {
          ok:
            result.summary.missingEpisodeIds.length === 0 &&
            result.summary.unexpectedEpisodeIds.length === 0,
          ...result.summary,
          passesOutput: resolve(required("--passes-output")),
          traceSourcesOutput: resolve(required("--trace-sources-output")),
          reportOutput: resolve(required("--report-output")),
        },
        null,
        2,
      ),
    );
    if (
      result.summary.missingEpisodeIds.length > 0 ||
      result.summary.unexpectedEpisodeIds.length > 0
    ) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "audit-oracle-pass-coverage") {
    const report = auditOraclePassCoverage(
      await readJsonl<TaskEpisode>(resolve(required("--episodes"))),
      await readJsonl<SilverLabelV1>(resolve(required("--passes"))),
    );
    await writeFile(
      resolve(required("--output")),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify(
        {
          ok: report.readyForAdjudication,
          expectedEpisodes: report.expectedEpisodeIds.length,
          missing: report.missingEpisodeIds.length,
          unexpected: report.unexpectedEpisodeIds.length,
          repeated: report.duplicatePasses.length,
          disagreements: report.decisionDisagreementEpisodeIds.length,
          output: resolve(required("--output")),
        },
        null,
        2,
      ),
    );
    if (!report.readyForAdjudication) process.exitCode = 1;
    return;
  }
  if (command === "merge-oracle-pass-artifacts") {
    const passFiles = args.flatMap((arg, index) =>
      arg === "--passes" && args[index + 1]
        ? [resolve(args[index + 1]!)]
        : []
    );
    const traceSourceFiles = args.flatMap((arg, index) =>
      arg === "--trace-sources" && args[index + 1]
        ? [resolve(args[index + 1]!)]
        : []
    );
    if (
      passFiles.length < 1 ||
      passFiles.length !== traceSourceFiles.length
    ) {
      throw new Error(
        "merge-oracle-pass-artifacts requires paired --passes and --trace-sources files",
      );
    }
    const artifacts = await Promise.all(
      passFiles.map(async (file, index) => ({
        labels: await readJsonl<SilverLabelV1>(file),
        traceSources: await readJsonl<CanonicalTraceSource>(
          traceSourceFiles[index]!,
        ),
      })),
    );
    const merged = mergeOraclePassArtifacts(artifacts);
    await writeJsonlPrivate(
      resolve(required("--passes-output")),
      merged.labels,
    );
    await writeJsonlPrivate(
      resolve(required("--trace-sources-output")),
      merged.traceSources,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          inputs: passFiles.length,
          passes: merged.labels.length,
          passesOutput: resolve(required("--passes-output")),
          traceSourcesOutput: resolve(required("--trace-sources-output")),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "select-canonical-oracle-passes") {
    const result = selectCanonicalOraclePasses({
      adjudicatedLabels: await readJsonl<SilverLabelV1>(
        resolve(required("--labels")),
      ),
      passes: await readJsonl<SilverLabelV1>(
        resolve(required("--passes")),
      ),
      traceSources: await readJsonl<CanonicalTraceSource>(
        resolve(required("--trace-sources")),
      ),
    });
    const passesOutput = resolve(required("--passes-output"));
    const traceSourcesOutput = resolve(
      required("--trace-sources-output"),
    );
    const reportOutput = resolve(required("--report-output"));
    await writeJsonlPrivate(passesOutput, result.canonicalPasses);
    await writeJsonlPrivate(
      traceSourcesOutput,
      result.canonicalTraceSources,
    );
    await writeFile(
      reportOutput,
      `${JSON.stringify(result.summary, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: true,
      ...result.summary,
      passesOutput,
      traceSourcesOutput,
      reportOutput,
    }, null, 2));
    return;
  }
  if (command === "prepare-coding-challenge") {
    const split = value("--split") ?? "test";
    if (split !== "validation" && split !== "test") {
      throw new Error("--split must be validation or test");
    }
    const cards = await readJsonl<AreaCardV1>(
      resolve(required("--areas")),
    );
    const result = buildCodingChallengeSuite(
      await readJsonl<TaskEpisode>(resolve(required("--episodes"))),
      await readJsonl<{
        taskEpisodeId: string;
        selectedAreaIds: string[];
      }>(resolve(required("--assignments"))),
      cards,
      split,
    );
    await writeJsonlPrivate(
      resolve(required("--episodes-output")),
      result.episodes,
    );
    await writeJsonlPrivate(
      resolve(required("--evidence-labels-output")),
      result.evidenceLabels,
    );
    await writeFile(
      resolve(required("--report-output")),
      `${JSON.stringify(result.report, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          ...result.report,
          episodesOutput: resolve(required("--episodes-output")),
          evidenceLabelsOutput: resolve(
            required("--evidence-labels-output"),
          ),
          reportOutput: resolve(required("--report-output")),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "prepare-luna-accuracy-development") {
    const result = buildResolvedDevelopmentSubset(
      await readJsonl<TaskEpisode>(resolve(required("--episodes"))),
      await readJsonl<SilverLabelV1>(resolve(required("--labels"))),
    );
    const episodesOutput = resolve(required("--episodes-output"));
    const labelsOutput = resolve(required("--labels-output"));
    const reportOutput = resolve(required("--report-output"));
    await writeJsonlPrivate(episodesOutput, result.episodes);
    await writeJsonlPrivate(labelsOutput, result.labels);
    await mkdir(resolve(reportOutput, ".."), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      reportOutput,
      `${JSON.stringify(result.report, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: true,
      ...result.report,
      episodesOutput,
      labelsOutput,
      reportOutput,
    }, null, 2));
    return;
  }
  if (command === "prepare-reviewed-coding-annotations") {
    const episodes = await readJsonl<TaskEpisode>(
      resolve(required("--episodes")),
    );
    const result = buildReviewedLunaAccuracyCodingAnnotations({
      episodes,
      drafts: await readJsonl<LunaAccuracyCodingAnnotationDraft>(
        resolve(required("--drafts")),
      ),
      reviewer: required("--reviewer"),
    });
    const annotationsOutput = resolve(
      required("--annotations-output"),
    );
    const auditOutput = resolve(required("--audit-output"));
    await writeJsonlPrivate(annotationsOutput, result.annotations);
    await mkdir(resolve(auditOutput, ".."), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      auditOutput,
      `${JSON.stringify(result.audit, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: true,
      ...result.audit,
      annotationsOutput,
      auditOutput,
    }, null, 2));
    return;
  }
  if (command === "prepare-github-coding-annotations") {
    const episodes = await readJsonl<TaskEpisode>(
      resolve(required("--episodes")),
    );
    const result = buildGithubLunaAccuracyCodingAnnotations({
      episodes,
      reviewer: required("--reviewer"),
    });
    const annotationsOutput = resolve(
      required("--annotations-output"),
    );
    const auditOutput = resolve(required("--audit-output"));
    await writeJsonlPrivate(annotationsOutput, result.annotations);
    await mkdir(resolve(auditOutput, ".."), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      auditOutput,
      `${JSON.stringify(result.audit, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: true,
      ...result.audit,
      annotationsOutput,
      auditOutput,
    }, null, 2));
    return;
  }
  if (command === "inherit-coding-annotations") {
    const derivedEpisodes = await readJsonl<TaskEpisode>(
      resolve(required("--derived-episodes")),
    );
    const provenance = await readJsonl<{
      derivativeEpisodeId: string;
      sourceEpisodeId: string;
    }>(resolve(required("--provenance")));
    const sourceEpisodeIdByDerivedId = new Map<string, string>();
    for (const item of provenance) {
      if (sourceEpisodeIdByDerivedId.has(item.derivativeEpisodeId)) {
        throw new Error(
          `Duplicate derivative provenance: ${item.derivativeEpisodeId}`,
        );
      }
      sourceEpisodeIdByDerivedId.set(
        item.derivativeEpisodeId,
        item.sourceEpisodeId,
      );
    }
    const result = inheritLunaAccuracyCodingAnnotations({
      sourceAnnotations: await readJsonl<LunaAccuracyCodingAnnotation>(
        resolve(required("--source-annotations")),
      ),
      derivedEpisodes,
      sourceEpisodeIdByDerivedId,
      reviewer: required("--reviewer"),
    });
    const annotationsOutput = resolve(
      required("--annotations-output"),
    );
    const auditOutput = resolve(required("--audit-output"));
    await writeJsonlPrivate(annotationsOutput, result.annotations);
    await mkdir(resolve(auditOutput, ".."), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      auditOutput,
      `${JSON.stringify(result.audit, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: true,
      ...result.audit,
      annotationsOutput,
      auditOutput,
    }, null, 2));
    return;
  }
  if (command === "audit-coding-annotations") {
    const audit = auditLunaAccuracyCodingAnnotations(
      await readJsonl<TaskEpisode>(resolve(required("--episodes"))),
      await readJsonl<LunaAccuracyCodingAnnotation>(
        resolve(required("--annotations")),
      ),
    );
    const auditOutput = resolve(required("--audit-output"));
    await mkdir(resolve(auditOutput, ".."), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      auditOutput,
      `${JSON.stringify(audit, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: audit.ready,
      ...audit,
      auditOutput,
    }, null, 2));
    if (!audit.ready) process.exitCode = 1;
    return;
  }
  if (command === "select-luna-accuracy-canary") {
    const episodes = await readJsonl<TaskEpisode>(
      resolve(required("--episodes")),
    );
    const annotations = await readJsonl<LunaAccuracyCodingAnnotation>(
      resolve(required("--coding-annotations")),
    );
    const annotationAudit = auditLunaAccuracyCodingAnnotations(
      episodes,
      annotations,
    );
    if (!annotationAudit.ready) {
      throw new Error("Canary coding annotations failed their audit");
    }
    const result = selectLunaAccuracyDevelopmentCanary(
      episodes,
      await readJsonl<SilverLabelV1>(resolve(required("--labels"))),
      new Map(
        annotations.map((annotation) => [
          annotation.taskEpisodeId,
          annotation.decision,
        ]),
      ),
      Number(value("--maximum-cases") ?? "10"),
    );
    const episodesOutput = resolve(required("--episodes-output"));
    const labelsOutput = resolve(required("--labels-output"));
    const annotationsOutput = resolve(
      required("--annotations-output"),
    );
    const reportOutput = resolve(required("--report-output"));
    await writeJsonlPrivate(episodesOutput, result.episodes);
    await writeJsonlPrivate(labelsOutput, result.labels);
    const selectedIds = new Set(result.episodes.map((episode) => episode.id));
    await writeJsonlPrivate(
      annotationsOutput,
      annotations.filter((annotation) =>
        selectedIds.has(annotation.taskEpisodeId)
      ),
    );
    await mkdir(resolve(reportOutput, ".."), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      reportOutput,
      `${JSON.stringify(result.report, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: true,
      ...result.report,
      episodesOutput,
      labelsOutput,
      annotationsOutput,
      reportOutput,
    }, null, 2));
    return;
  }
  if (command === "prepare-luna-coding-development") {
    const suite = buildLunaGroundedCodingDevelopmentSuite({
      episodes: await readJsonl<TaskEpisode>(
        resolve(required("--episodes")),
      ),
      assignments: await readJsonl<{
        taskEpisodeId: string;
        selectedAreaIds: string[];
      }>(resolve(required("--assignments"))),
      cards: await readJsonl<AreaCardV1>(
        resolve(required("--areas")),
      ),
    });
    const baseEpisodesOutput = resolve(
      required("--base-episodes-output"),
    );
    const baseLabelsOutput = resolve(required("--base-labels-output"));
    const derivedEpisodesOutput = resolve(
      required("--derived-episodes-output"),
    );
    const derivedLabelsOutput = resolve(
      required("--derived-labels-output"),
    );
    const provenanceOutput = resolve(required("--provenance-output"));
    const reportOutput = resolve(required("--report-output"));
    await writeJsonlPrivate(baseEpisodesOutput, suite.baseEpisodes);
    await writeJsonlPrivate(baseLabelsOutput, suite.baseLabels);
    await writeJsonlPrivate(
      derivedEpisodesOutput,
      suite.derivedEpisodes,
    );
    await writeJsonlPrivate(derivedLabelsOutput, suite.derivedLabels);
    await writeJsonlPrivate(provenanceOutput, suite.provenance);
    await mkdir(resolve(reportOutput, ".."), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      reportOutput,
      `${JSON.stringify(suite.report, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: true,
      ...suite.report,
      baseEpisodesOutput,
      baseLabelsOutput,
      derivedEpisodesOutput,
      derivedLabelsOutput,
      provenanceOutput,
      reportOutput,
    }, null, 2));
    return;
  }
  if (command === "generate-luna-accuracy-phase1") {
    const matrix = buildLunaAccuracyPhaseOneMatrix();
    const output = resolve(required("--output"));
    await writeFile(output, `${JSON.stringify(matrix, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(JSON.stringify({
      ok: true,
      output,
      variants: matrix.variants.length,
      latestRequestOnlySupported: false,
    }, null, 2));
    return;
  }
  if (command === "generate-luna-accuracy-phase2") {
    const phaseOne = JSON.parse(
      await readFile(resolve(required("--phase1-matrix")), "utf8"),
    ) as LunaAccuracyMatrixV2;
    validateLunaAccuracyMatrixV2(phaseOne);
    const report = JSON.parse(
      await readFile(resolve(required("--phase1-report")), "utf8"),
    ) as LunaAccuracySelectionReport;
    const runManifest = JSON.parse(
      await readFile(resolve(required("--phase1-manifest")), "utf8"),
    ) as LunaAccuracyRunManifest;
    const attestation = JSON.parse(
      await readFile(resolve(required("--phase1-attestation")), "utf8"),
    ) as LunaAccuracyAnalysisAttestationV1;
    const profile = JSON.parse(
      await readFile(resolve(required("--profile")), "utf8"),
    ) as RepositoryProfileV1;
    const cards = await readJsonl<AreaCardV1>(
      resolve(required("--areas")),
    );
    const episodes = await readJsonl<TaskEpisode>(
      resolve(required("--episodes")),
    );
    const labels = await readJsonl<SilverLabelV1>(
      resolve(required("--labels")),
    );
    const codingAnnotations =
      await readJsonl<LunaAccuracyCodingAnnotation>(
        resolve(required("--coding-annotations")),
      );
    const calls = await readJsonl<LunaAccuracyCallRecord>(
      resolve(required("--calls")),
    );
    validateLunaAccuracyPhaseOneTransition({
      phaseOne,
      report,
      runManifest,
      attestation,
      analysisInputs: {
        model: LUNA_ACCURACY_MODEL,
        datasetRole: "validation",
        dataSource: "real_user",
        profile,
        cards,
        episodes,
        labels,
        codingAnnotations,
        calls,
      },
    });
    const rankedIds = report.ranking.map((entry) => entry.variantId);
    const matrix = buildLunaAccuracyPhaseTwoMatrix(phaseOne, rankedIds);
    const output = resolve(required("--output"));
    await writeFile(output, `${JSON.stringify(matrix, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(JSON.stringify({
      ok: true,
      output,
      variants: matrix.variants.length,
      repetitions: 3,
    }, null, 2));
    return;
  }
  if (command === "generate-luna-accuracy-phase2b") {
    const matrix = buildLunaAccuracyPhaseTwoBMatrix();
    const output = resolve(required("--output"));
    await mkdir(resolve(output, ".."), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(output, `${JSON.stringify(matrix, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(JSON.stringify({
      ok: true,
      output,
      variants: matrix.variants.length,
      repetitionsPerVariant: 7,
      providerDistinctTreatmentsRequired: true,
      latestRequestOnlySupported: false,
    }, null, 2));
    return;
  }
  if (command === "analyze-luna-accuracy-phase2b") {
    const matrix = JSON.parse(
      await readFile(resolve(required("--phase2b-matrix")), "utf8"),
    ) as LunaAccuracyMatrixV2;
    validateLunaAccuracyMatrixV2(matrix);
    const runManifest = JSON.parse(
      await readFile(resolve(required("--phase2b-manifest")), "utf8"),
    ) as LunaAccuracyRunManifest;
    const profile = JSON.parse(
      await readFile(resolve(required("--profile")), "utf8"),
    ) as RepositoryProfileV1;
    const cards = await readJsonl<AreaCardV1>(
      resolve(required("--areas")),
    );
    const episodes = await readJsonl<TaskEpisode>(
      resolve(required("--episodes")),
    );
    const labels = await readJsonl<SilverLabelV1>(
      resolve(required("--labels")),
    );
    const codingAnnotations =
      await readJsonl<LunaAccuracyCodingAnnotation>(
        resolve(required("--coding-annotations")),
      );
    const calls = await readJsonl<LunaAccuracyCallRecord>(
      resolve(required("--calls")),
    );
    const selection = buildLunaAccuracyPhaseTwoBSelection({
      model: LUNA_ACCURACY_MODEL,
      profile,
      cards,
      episodes,
      labels,
      codingAnnotations,
      matrix,
      calls,
      runManifest,
    });
    const selectionOutput = resolve(required("--selection-output"));
    await writePrivateJson(selectionOutput, selection);
    console.log(JSON.stringify({
      ok: true,
      selectionOutput,
      outcome: selection.outcome,
      selectedVariantId: selection.selectedVariantId,
      stableVariants: selection.variants
        .filter((variant) => variant.stability.passed)
        .map((variant) => variant.variantId),
      comparisons: selection.comparisons.length,
    }, null, 2));
    return;
  }
  if (command === "generate-luna-accuracy-phase3") {
    const phaseTwoB = JSON.parse(
      await readFile(resolve(required("--phase2b-matrix")), "utf8"),
    ) as LunaAccuracyMatrixV2;
    validateLunaAccuracyMatrixV2(phaseTwoB);
    const selection = JSON.parse(
      await readFile(resolve(required("--phase2b-selection")), "utf8"),
    ) as LunaAccuracyPhaseTwoBSelection;
    const runManifest = JSON.parse(
      await readFile(resolve(required("--phase2b-manifest")), "utf8"),
    ) as LunaAccuracyRunManifest;
    const profile = JSON.parse(
      await readFile(resolve(required("--profile")), "utf8"),
    ) as RepositoryProfileV1;
    const cards = await readJsonl<AreaCardV1>(
      resolve(required("--areas")),
    );
    const episodes = await readJsonl<TaskEpisode>(
      resolve(required("--episodes")),
    );
    const labels = await readJsonl<SilverLabelV1>(
      resolve(required("--labels")),
    );
    const codingAnnotations =
      await readJsonl<LunaAccuracyCodingAnnotation>(
        resolve(required("--coding-annotations")),
      );
    const calls = await readJsonl<LunaAccuracyCallRecord>(
      resolve(required("--calls")),
    );
    const verified = validateLunaAccuracyPhaseTwoBSelection({
      model: LUNA_ACCURACY_MODEL,
      profile,
      cards,
      episodes,
      labels,
      codingAnnotations,
      matrix: phaseTwoB,
      calls,
      runManifest,
      selection,
    });
    const { primary, alternative } =
      selectLunaAccuracyPhaseThreeContexts({
        matrix: phaseTwoB,
        selection: verified,
      });
    const design = buildLunaAccuracyPhaseThreeDesign(
      primary,
      alternative,
    );
    const matrixOutput = resolve(required("--matrix-output"));
    const armsOutput = resolve(required("--arms-output"));
    await mkdir(resolve(matrixOutput, ".."), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(resolve(armsOutput, ".."), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      matrixOutput,
      `${JSON.stringify(design.matrix, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      armsOutput,
      `${JSON.stringify(design.arms, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: true,
      matrixOutput,
      armsOutput,
      primaryVariantId: primary.id,
      alternativeVariantId: alternative.id,
      architectures: design.arms.map((arm) => arm.architecture),
    }, null, 2));
    return;
  }
  if (command === "analyze-luna-accuracy-phase3") {
    const matrix = JSON.parse(
      await readFile(resolve(required("--matrix")), "utf8"),
    ) as LunaAccuracyMatrixV2;
    validateLunaAccuracyMatrixV2(matrix);
    const arms = JSON.parse(
      await readFile(resolve(required("--arms")), "utf8"),
    ) as LunaAccuracyExperimentArm[];
    const runManifest = JSON.parse(
      await readFile(resolve(required("--manifest")), "utf8"),
    ) as LunaAccuracyRunManifest;
    const profile = JSON.parse(
      await readFile(resolve(required("--profile")), "utf8"),
    ) as RepositoryProfileV1;
    const cards = await readJsonl<AreaCardV1>(
      resolve(required("--areas")),
    );
    const episodes = await readJsonl<TaskEpisode>(
      resolve(required("--episodes")),
    );
    const labels = await readJsonl<SilverLabelV1>(
      resolve(required("--labels")),
    );
    const codingAnnotations =
      await readJsonl<LunaAccuracyCodingAnnotation>(
        resolve(required("--coding-annotations")),
      );
    const calls = await readJsonl<LunaAccuracyCallRecord>(
      resolve(required("--calls")),
    );
    const selection = buildLunaAccuracyPhaseThreeSelection({
      model: LUNA_ACCURACY_MODEL,
      profile,
      cards,
      episodes,
      labels,
      codingAnnotations,
      matrix,
      arms,
      calls,
      runManifest,
    });
    const selectionOutput = resolve(required("--selection-output"));
    await writePrivateJson(selectionOutput, selection);
    console.log(JSON.stringify({
      ok: true,
      selectionOutput,
      selectedArchitecture: selection.selection.selectedArchitecture,
      selectedPrimaryArmId: selection.selection.selectedPrimaryArmId,
      outcome: selection.selection.outcome,
      architectureAnalyses: selection.architectureAnalyses.map((analysis) => ({
        architecture: analysis.architecture,
        passedBothContexts: analysis.passedBothContexts,
        averageObservedSelectionScoreLead:
          analysis.averageObservedSelectionScoreLead,
      })),
    }, null, 2));
    return;
  }
  if (command === "prepare-luna-accuracy-challenges") {
    const split = value("--split") ?? "validation";
    if (
      split !== "reference" &&
      split !== "validation" &&
      split !== "test"
    ) {
      throw new Error("--split must be reference, validation, or test");
    }
    const safeTruncationIds = value("--safe-truncation-ids")
      ? JSON.parse(
          await readFile(
            resolve(value("--safe-truncation-ids")!),
            "utf8",
          ),
        ) as string[]
      : undefined;
    const freeze = value("--freeze")
      ? JSON.parse(
          await readFile(resolve(value("--freeze")!), "utf8"),
        ) as LunaAccuracyFreezeRecord
      : undefined;
    const suite = buildLunaCounterfactualChallengeSuite({
      episodes: await readJsonl<TaskEpisode>(
        resolve(required("--episodes")),
      ),
      labels: await readJsonl<SilverLabelV1>(
        resolve(required("--labels")),
      ),
      cards: await readJsonl<AreaCardV1>(resolve(required("--areas"))),
      maximumSourceCases: Number(value("--maximum-source-cases") ?? "12"),
      split,
      ...(safeTruncationIds ? { safeTruncationEpisodeIds: safeTruncationIds } : {}),
      ...(freeze ? { lockedTestFreeze: freeze } : {}),
    });
    const episodesOutput = resolve(required("--episodes-output"));
    const labelsOutput = resolve(required("--labels-output"));
    const provenanceOutput = resolve(required("--provenance-output"));
    const scenariosOutput = resolve(required("--scenarios-output"));
    await writeJsonlPrivate(episodesOutput, suite.episodes);
    await writeJsonlPrivate(labelsOutput, suite.labels);
    await writeJsonlPrivate(provenanceOutput, suite.provenance);
    await writeFile(
      scenariosOutput,
      `${JSON.stringify({
        schemaVersion: suite.schemaVersion,
        specificationVersion: suite.specificationVersion,
        split: suite.split,
        sourceCases: suite.sourceCases,
        registryScenarios: suite.registryScenarios,
        reportingPolicy: suite.reportingPolicy,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: true,
      split: suite.split,
      sourceCases: suite.sourceCases,
      derivedEpisodes: suite.episodes.length,
      registryScenarios: suite.registryScenarios.length,
      episodesOutput,
      labelsOutput,
      provenanceOutput,
      scenariosOutput,
    }, null, 2));
    return;
  }
  if (
    command === "plan-luna-accuracy" ||
    command === "run-luna-accuracy"
  ) {
    const execute = command === "run-luna-accuracy";
    if (execute && !has("--confirm-external-run")) {
      throw new Error(
        "Refusing hosted calls without --confirm-external-run",
      );
    }
    const model = value("--model") ?? LUNA_ACCURACY_MODEL;
    if (model !== LUNA_ACCURACY_MODEL) {
      throw new Error(`Luna accuracy requires ${LUNA_ACCURACY_MODEL}`);
    }
    const profile = JSON.parse(
      await readFile(resolve(required("--profile")), "utf8"),
    ) as RepositoryProfileV1;
    const cards = await readJsonl<AreaCardV1>(
      resolve(required("--areas")),
    );
    const episodes = await readJsonl<TaskEpisode>(
      resolve(required("--episodes")),
    );
    const matrix = JSON.parse(
      await readFile(resolve(required("--matrix")), "utf8"),
    ) as LunaAccuracyMatrixV2;
    const arms = value("--arms")
      ? JSON.parse(
          await readFile(resolve(value("--arms")!), "utf8"),
        ) as LunaAccuracyExperimentArm[]
      : undefined;
    const datasetRole = (
      value("--dataset-role") ?? "validation"
    ) as LunaAccuracyDatasetRole;
    if (
      ![
        "burned_development",
        "validation",
        "locked_test",
      ].includes(datasetRole)
    ) {
      throw new Error("Invalid --dataset-role");
    }
    const dataSource = required("--data-source") as LunaAccuracyDataSource;
    if (!LUNA_ACCURACY_DATA_SOURCES.includes(dataSource)) {
      throw new Error("Invalid --data-source");
    }
    const freeze = value("--freeze")
      ? JSON.parse(
          await readFile(resolve(value("--freeze")!), "utf8"),
        ) as LunaAccuracyFreezeRecord
      : undefined;
    const scheduleSeed = Number(value("--schedule-seed") ?? "19871");
    const concurrency = Number(value("--concurrency") ?? "1");
    const price = (await fetchModelPrices()).get(model);
    if (!price) throw new Error(`Model not in OpenRouter catalog: ${model}`);
    const plan = planLunaAccuracyWorkflow({
      model,
      profile,
      cards,
      episodes,
      matrix,
      price,
      ...(arms ? { arms } : {}),
      concurrency,
      scheduleSeed,
      datasetRole,
      ...(freeze ? { freeze } : {}),
    });
    const reservation = Number(
      value("--maximum-cost-usd") ??
        String(plan.projectedMaximumCostUsd),
    );
    console.log(JSON.stringify({
      ok: true,
      plan: true,
      dryRun: !execute,
      hostedProvider: "OpenRouter",
      ...plan,
      maximumCostUsd: reservation,
      hardExperimentBudgetCeilingUsd: EXPERIMENT_BUDGET_CEILING_USD,
      privateFieldsLeavingMachine: [
        "bounded task-aware context",
        "configured frozen Area Registry representation",
      ],
      executionRequires: "--confirm-external-run",
    }, null, 2));
    if (!execute) return;
    const labels = await readJsonl<SilverLabelV1>(
      resolve(required("--labels")),
    );
    const codingAnnotations =
      await readJsonl<LunaAccuracyCodingAnnotation>(
        resolve(required("--coding-annotations")),
      );
    codingEpisodeIdsFromAnnotations(episodes, codingAnnotations);
    validateBenchmarkDataset(profile, cards, episodes, labels);
    const artifacts = resolve(required("--artifacts"));
    const directory = resolve(artifacts, required("--run-id"));
    const result = await runBudgetedLunaAccuracyWorkflow({
      runDirectory: directory,
      model,
      profile,
      cards,
      episodes,
      matrix,
      price,
      reservationUsd: reservation,
      budgetLedger: new BudgetLedger(
        resolve(artifacts, "global-budget.json"),
        EXPERIMENT_BUDGET_CEILING_USD,
      ),
      getProviderStatus: getOpenRouterKeyStatus,
      executor: createLunaAccuracyOpenRouterExecutor(),
      ...(arms ? { arms } : {}),
      concurrency,
      scheduleSeed,
      datasetRole,
      ...(freeze ? { freeze } : {}),
      allowEquivalentTreatmentReplicates:
        has("--allow-equivalent-treatment-replicates"),
    });
    const attested = buildLunaAccuracyAttestedAnalysis({
      model,
      datasetRole,
      dataSource,
      profile,
      cards,
      episodes,
      labels,
      codingAnnotations,
      calls: result.run.callRecords,
      runManifest: result.run.manifest,
      matrix,
      ...(arms ? { arms } : {}),
    });
    const {
      report,
      treatmentReport,
      distinctnessAudit,
      attestation,
    } = attested;
    const reportOutput = resolve(directory, "metrics", "accuracy.json");
    const treatmentOutput = resolve(
      directory,
      "metrics",
      "accuracy-treatments.json",
    );
    const distinctnessOutput = resolve(
      directory,
      "metrics",
      "treatment-distinctness.json",
    );
    const attestationOutput = resolve(
      directory,
      "metrics",
      "analysis-attestation.json",
    );
    await mkdir(resolve(directory, "metrics"), {
      recursive: true,
      mode: 0o700,
    });
    await writePrivateJson(reportOutput, report);
    await writePrivateJson(treatmentOutput, treatmentReport);
    await writePrivateJson(distinctnessOutput, distinctnessAudit);
    await writePrivateJson(attestationOutput, attestation);
    console.log(JSON.stringify({
      ok: true,
      directory,
      reportOutput,
      treatmentOutput,
      distinctnessOutput,
      attestationOutput,
      executedCalls: result.run.executedCalls,
      resumedCalls: result.run.resumedCalls,
      predictionSets: result.run.predictionSets.length,
      treatments: treatmentReport.treatments,
      winner: treatmentReport.recommendation,
      accounting: result.accounting,
    }, null, 2));
    return;
  }
  if (command === "analyze-luna-accuracy") {
    const model = required("--model");
    if (model !== LUNA_ACCURACY_MODEL) {
      throw new Error(`Luna accuracy requires ${LUNA_ACCURACY_MODEL}`);
    }
    const profile = JSON.parse(
      await readFile(resolve(required("--profile")), "utf8"),
    ) as RepositoryProfileV1;
    const cards = await readJsonl<AreaCardV1>(
      resolve(required("--areas")),
    );
    const episodes = await readJsonl<TaskEpisode>(
      resolve(required("--episodes")),
    );
    const labels = await readJsonl<SilverLabelV1>(
      resolve(required("--labels")),
    );
    const codingAnnotations =
      await readJsonl<LunaAccuracyCodingAnnotation>(
        resolve(required("--coding-annotations")),
      );
    const codingEpisodeIds = codingEpisodeIdsFromAnnotations(
      episodes,
      codingAnnotations,
    );
    const matrix = JSON.parse(
      await readFile(resolve(required("--matrix")), "utf8"),
    ) as LunaAccuracyMatrixV2;
    validateLunaAccuracyMatrixV2(matrix);
    const arms = value("--arms")
      ? JSON.parse(
          await readFile(resolve(value("--arms")!), "utf8"),
        ) as LunaAccuracyExperimentArm[]
      : undefined;
    const calls = await readJsonl<LunaAccuracyCallRecord>(
      resolve(required("--calls")),
    );
    const runManifest = JSON.parse(
      await readFile(resolve(required("--manifest")), "utf8"),
    ) as LunaAccuracyRunManifest;
    const datasetRole = required(
      "--dataset-role",
    ) as LunaAccuracyDatasetRole;
    const dataSource = required("--data-source") as LunaAccuracyDataSource;
    if (!LUNA_ACCURACY_DATA_SOURCES.includes(dataSource)) {
      throw new Error("Invalid --data-source");
    }
    const attested = buildLunaAccuracyAttestedAnalysis({
      model,
      datasetRole,
      dataSource,
      profile,
      cards,
      episodes,
      labels,
      codingAnnotations,
      calls,
      runManifest,
      matrix,
      ...(arms ? { arms } : {}),
    });
    const {
      report,
      treatmentReport,
      distinctnessAudit,
      attestation,
      predictionSets,
    } = attested;
    const output = resolve(required("--output"));
    await writePrivateJson(output, report);
    const treatmentOutput = resolve(required("--treatment-output"));
    await writePrivateJson(treatmentOutput, treatmentReport);
    const distinctnessOutput = resolve(required("--distinctness-output"));
    await writePrivateJson(distinctnessOutput, distinctnessAudit);
    const attestationOutput = resolve(required("--attestation-output"));
    await writePrivateJson(attestationOutput, attestation);
    const bootstrapOutput = value("--bootstrap-output");
    let writtenBootstrapOutput: string | undefined;
    if (bootstrapOutput && report.ranking.length >= 2) {
      const topSets = report.ranking
        .slice(0, 2)
        .map((entry) =>
          selectBootstrapPredictionSet(predictionSets, entry.armId)
        )
        .filter(
          (
            set,
          ): set is ReturnType<
            typeof buildLunaAccuracyPredictionSets
          >[number] => set !== undefined,
        );
      if (topSets.length === 2) {
        writtenBootstrapOutput = resolve(bootstrapOutput);
        await mkdir(resolve(writtenBootstrapOutput, ".."), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(
          writtenBootstrapOutput,
          `${JSON.stringify(compareLunaAccuracyTopTwo({
            report,
            episodes,
            labels,
            predictionSets: topSets,
            codingEpisodeIds,
            iterations: Number(
              value("--bootstrap-iterations") ?? "5000",
            ),
            seed: Number(value("--bootstrap-seed") ?? "17"),
          }), null, 2)}\n`,
          { mode: 0o600 },
        );
      }
    }
    console.log(JSON.stringify({
      ok: true,
      output,
      treatmentOutput,
      distinctnessOutput,
      attestationOutput,
      candidates: report.candidates.length,
      treatments: treatmentReport.treatments,
      winner: treatmentReport.recommendation,
      ...(bootstrapOutput
        ? {
          bootstrapRequested: resolve(bootstrapOutput),
          bootstrapWritten: writtenBootstrapOutput !== undefined,
          ...(writtenBootstrapOutput
            ? { bootstrapOutput: writtenBootstrapOutput }
            : {}),
        }
        : {}),
    }, null, 2));
    return;
  }
  if (command === "select-canary") {
    const episodes = await readJsonl<TaskEpisode>(resolve(required("--episodes")));
    const profile = JSON.parse(await readFile(resolve(required("--profile")), "utf8")) as RepositoryProfileV1;
    const selected = selectOracleCanary(episodes, profile, Number(value("--count") ?? "10"));
    await writeJsonlPrivate(resolve(required("--output")), selected.episodes);
    console.log(JSON.stringify({ ok: true, episodes: selected.episodes.map((item) => ({ id: item.id, source: item.source })), composition: selected.composition, warnings: selected.warnings }, null, 2));
    return;
  }
  if (command === "validate") {
    const profile = JSON.parse(await readFile(resolve(required("--profile")), "utf8")) as RepositoryProfileV1;
    const cards = await readJsonl<AreaCardV1>(resolve(required("--areas")));
    const episodes = await readJsonl<TaskEpisode>(resolve(required("--episodes")));
    validateRepositoryProfile(profile); validateAreaCards(cards, profile); validateEpisodes(episodes, cards);
    const labelsFile = value("--labels"); if (labelsFile) validateSilverLabels(await readJsonl<SilverLabelV1>(resolve(labelsFile)), cards);
    console.log(JSON.stringify({ ok: true, repositoryId: profile.repositoryId, areaCards: cards.length, episodes: episodes.length, labels: labelsFile ? (await readJsonl<SilverLabelV1>(resolve(labelsFile))).length : 0 }, null, 2));
    return;
  }
  if (command === "audit-label-evidence") {
    const report = await auditSilverLabelRepositoryEvidence(
      await readJsonl<SilverLabelV1>(resolve(required("--labels"))),
      await readJsonl<TaskEpisode>(resolve(required("--episodes"))),
      resolve(required("--repository")),
    );
    await writeFile(
      resolve(required("--output")),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: report.ready,
      output: resolve(required("--output")),
      labels: report.labels,
      labelsRequiringInspection: report.labelsRequiringInspection,
      labelsWithInspection: report.labelsWithInspection,
      pathsChecked: report.pathsChecked,
      missingPaths: report.missingPaths.length,
      missingEpisodes: report.missingEpisodes.length,
      insufficientInspection: report.insufficientInspection.length,
    }, null, 2));
    if (!report.ready) process.exitCode = 1;
    return;
  }
  if (command === "audit-oracle-traces") {
    const report = await auditOracleTraces({
      labels: await readJsonl<SilverLabelV1>(resolve(required("--labels"))),
      canonicalPasses: await readJsonl<SilverLabelV1>(
        resolve(required("--passes")),
      ),
      traceSources: await readJsonl<CanonicalTraceSource>(
        resolve(required("--trace-sources")),
      ),
      episodes: await readJsonl<TaskEpisode>(resolve(required("--episodes"))),
      repository: resolve(required("--repository")),
    });
    await writeFile(
      resolve(required("--output")),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({
      ok: report.ready,
      output: resolve(required("--output")),
      labels: report.labels,
      canonicalPasses: report.canonicalPasses,
      tracesAudited: report.tracesAudited,
      commandExecutions: report.commandExecutions,
      webSearchEvents: report.webSearchEvents,
      failedGates: report.gates
        .filter((gate) => !gate.passed)
        .map((gate) => gate.gate),
    }, null, 2));
    if (!report.ready) process.exitCode = 1;
    return;
  }
  if (command === "run-oracle") {
    if (!has("--confirm-external-run")) throw new Error("Refusing hosted calls without --confirm-external-run");
    const cards = await readJsonl<AreaCardV1>(resolve(required("--areas")));
    const episodes = await readJsonl<TaskEpisode>(resolve(required("--episodes")));
    validateEpisodes(episodes); if (cards.length < 2) throw new Error("Oracle requires at least two Area Cards");
    const model = required("--model"); const passes = Number(value("--passes") ?? "2"); const maxOutput = Number(value("--max-output-tokens") ?? "800");
    const price = (await fetchModelPrices()).get(model); if (!price) throw new Error(`Model not in OpenRouter catalog: ${model}`);
    const explicitInputTokens = episodes.reduce((sum, episode) => sum + estimateTokens(buildOraclePrompt(episode, cards)), 0) * passes;
    const projectedInputTokens = explicitInputTokens + episodes.length * passes * CODEX_HARNESS_INPUT_OVERHEAD_TOKENS_PER_CALL;
    const reservedOutputTokens = episodes.length * passes * maxOutput;
    const reservation = maximumCallCost(price, projectedInputTokens, reservedOutputTokens);
    const runId = required("--run-id"); const artifactsRoot = resolve(required("--artifacts")); const directory = await createRunDirectory(artifactsRoot, runId);
    const ledger = new BudgetLedger(`${artifactsRoot}/global-budget.json`, EXPERIMENT_BUDGET_CEILING_USD); await ledger.reserve(reservation);
    let keyBefore: Awaited<ReturnType<typeof getOpenRouterKeyStatus>> | undefined;
    let hostedStarted = false;
    const labels: SilverLabelV1[] = [];
    const measuredUsage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    let settled = false;
    try {
      keyBefore = await getOpenRouterKeyStatus();
      if (keyBefore.limitRemainingUsd !== null && keyBefore.limitRemainingUsd + 1e-9 < reservation) throw new Error(`OpenRouter key has only $${keyBefore.limitRemainingUsd.toFixed(6)} remaining; reservation requires $${reservation.toFixed(6)}`);
      await writeImmutable(`${directory}/manifest.lock.json`, { schemaVersion: 1, runId, createdAt: new Date().toISOString(), model, passes, repository: resolve(required("--repository")), episodeIds: episodes.map((item) => item.id), areaRegistryVersion: cards[0]?.registryVersion, maximumCostUsd: reservation, projectedInputTokens, reservedOutputTokens, openRouterKeyLimitUsd: keyBefore.limitUsd });
      for (const episode of episodes) {
        hostedStarted = true;
        const perEpisode = await runSilverOracle({ repository: resolve(required("--repository")), episode, cards, model, passCount: passes, onTrace: async (trace) => {
          measuredUsage.inputTokens += trace.usage.inputTokens;
          measuredUsage.cachedInputTokens += trace.usage.cachedInputTokens;
          measuredUsage.cacheWriteInputTokens += trace.usage.cacheWriteInputTokens;
          measuredUsage.outputTokens += trace.usage.outputTokens;
          measuredUsage.reasoningOutputTokens += trace.usage.reasoningOutputTokens;
          await writeImmutable(`${directory}/private/oracle-traces/${episode.id}-pass-${trace.pass}.json`, trace, true);
        } });
        labels.push(...perEpisode);
      }
      await writeJsonlPrivate(`${directory}/private/silver-label-passes.jsonl`, labels);
      const keyAfter = await getOpenRouterKeyStatus();
      const providerMeteredCostUsd = Math.max(0, (keyAfter.accountUsageUsd ?? keyAfter.usageUsd) - (keyBefore.accountUsageUsd ?? keyBefore.usageUsd));
      const apiEquivalentCostUsd = maximumCallCost(price, measuredUsage.inputTokens, measuredUsage.outputTokens);
      const actualCostUsd = Math.max(providerMeteredCostUsd, apiEquivalentCostUsd);
      await writeImmutable(`${directory}/cost.json`, {
        keyUsageBeforeUsd: keyBefore.usageUsd,
        keyUsageAfterUsd: keyAfter.usageUsd,
        accountUsageBeforeUsd: keyBefore.accountUsageUsd,
        accountUsageAfterUsd: keyAfter.accountUsageUsd,
        providerMeteredCostUsd,
        apiEquivalentCostUsd,
        measuredUsage,
        actualCostUsd,
        maximumCostUsd: reservation,
      });
      await ledger.settle(reservation, actualCostUsd);
      settled = true;
      console.log(JSON.stringify({ ok: true, runId, directory, labels: labels.length, actualCostUsd, maximumCostUsd: reservation }, null, 2));
    } catch (error) {
      if (!settled) {
        try {
          if (!hostedStarted || !keyBefore) {
            await ledger.release(reservation);
          } else {
            const keyAfter = await getOpenRouterKeyStatus();
            const providerMeteredCostUsd = Math.max(
              0,
              (keyAfter.accountUsageUsd ?? keyAfter.usageUsd) -
                (keyBefore.accountUsageUsd ?? keyBefore.usageUsd),
            );
            const apiEquivalentCostUsd = maximumCallCost(
              price,
              measuredUsage.inputTokens,
              measuredUsage.outputTokens,
            );
            const actualCostUsd = Math.max(
              providerMeteredCostUsd,
              apiEquivalentCostUsd,
            );
            await writeImmutable(`${directory}/partial-cost.json`, {
              keyUsageBeforeUsd: keyBefore.usageUsd,
              keyUsageAfterUsd: keyAfter.usageUsd,
              accountUsageBeforeUsd: keyBefore.accountUsageUsd,
              accountUsageAfterUsd: keyAfter.accountUsageUsd,
              providerMeteredCostUsd,
              apiEquivalentCostUsd,
              measuredUsage,
              actualCostUsd,
              maximumCostUsd: reservation,
            });
            await ledger.settle(reservation, actualCostUsd);
          }
          settled = true;
        } catch {}
      }
      console.error(`Partial results preserved in ${directory}`); throw error;
    }
    return;
  }
  if (command === "plan-oracle") {
    const cards = await readJsonl<AreaCardV1>(resolve(required("--areas")));
    const episodes = await readJsonl<TaskEpisode>(resolve(required("--episodes")));
    validateEpisodes(episodes); if (cards.length < 2) throw new Error("Oracle requires at least two Area Cards");
    const model = required("--model"); const passes = Number(value("--passes") ?? "2"); const maxOutput = Number(value("--max-output-tokens") ?? "800");
    const price = (await fetchModelPrices()).get(model); if (!price) throw new Error(`Model not in OpenRouter catalog: ${model}`);
    const calls = episodes.length * passes;
    const explicitInputTokens = episodes.reduce((sum, episode) => sum + estimateTokens(buildOraclePrompt(episode, cards)), 0) * passes;
    const inputTokens = explicitInputTokens + calls * CODEX_HARNESS_INPUT_OVERHEAD_TOKENS_PER_CALL;
    const outputTokens = calls * maxOutput;
    const maximumCostUsd = maximumCallCost(price, inputTokens, outputTokens);
    console.log(JSON.stringify({ ok: true, dryRun: true, model, episodes: episodes.length, passes, calls, explicitPromptTokens: explicitInputTokens, codexHarnessOverheadTokens: calls * CODEX_HARNESS_INPUT_OVERHEAD_TOKENS_PER_CALL, projectedInputTokens: inputTokens, reservedOutputTokens: outputTokens, maximumCostUsd, privateFieldsLeavingMachine: ["currentRequest", "taskAnchor", "precedingAssistant", "earlierUserContext", "relevantDiagnostic", "Area Cards", "repository files accessed by Codex tools"], executionRequires: "--confirm-external-run on a future run command" }, null, 2));
    return;
  }
  if (!command || has("--help")) usage();
  usage();
};

main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
