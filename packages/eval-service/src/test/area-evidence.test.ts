import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  EvalComparisonCase,
  EvalComparisonResult,
  RoutingAreaCatalog
} from "@velum-labs/routekit-eval-contracts";

import { compileAreaEvidenceMatrix, wilsonLowerBound95 } from "../area-evidence.js";

const areaIds = [
  "gateway-protocol",
  "eval-routing",
  "account-pooling",
  "typescript-maintenance",
  "release-operations"
] as const;
const models = ["openai/model-a", "openai/model-b"] as const;
const caseIds = ["case-1", "case-2", "case-3", "case-4", "case-5"] as const;
const judgeModel = "openai/judge";

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends ReadonlyArray<infer Item>
    ? Array<Mutable<Item>>
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key];
};

function mutable<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}

const catalog: RoutingAreaCatalog = {
  version: 2,
  definitionSetDigest: "definition-set-v2",
  areas: areaIds.map((id) => ({
    id,
    description: `Requests about ${id}`,
    includes: [`Tasks specifically involving ${id}`],
    excludes: [`Tasks unrelated to ${id}`]
  }))
};

function cases(
  options: {
    failed?: ReadonlySet<string>;
    unpriced?: ReadonlySet<string>;
    missingDuration?: ReadonlySet<string>;
  } = {}
): EvalComparisonCase[] {
  return caseIds.map((caseId, index) => {
    const passed = !options.failed?.has(caseId);
    return {
      caseId,
      outcome: passed ? "passed" : "failed",
      measurement: {
        judgeScore: passed ? 0.9 : 0.2,
        ...(!options.unpriced?.has(caseId) ? { costUsd: 0.01 + index / 1_000 } : {}),
        ...(!options.missingDuration?.has(caseId) ? { durationMs: 100 + index * 10 } : {}),
        inputTokens: 100 + index,
        outputTokens: 20 + index
      }
    };
  });
}

function comparison(areaId: string): EvalComparisonResult {
  return {
    version: 1,
    comparisonId: `comparison-${areaId}`,
    profileId: areaId,
    suiteDigest: `suite-${areaId}`,
    judgeModel,
    startedAt: "2026-08-17T00:00:00.000Z",
    finishedAt: "2026-08-17T00:01:00.000Z",
    models: models.map((model) => ({ model, cases: cases() }))
  };
}

function input() {
  return mutable({
    catalog,
    candidateModels: models,
    comparisons: areaIds.map((areaId) => ({
      areaId,
      suiteDigest: `suite-${areaId}`,
      judgeModel,
      expectedCaseIds: caseIds,
      comparison: comparison(areaId)
    }))
  });
}

test("complete comparison results compile into a deterministic model-area matrix", () => {
  const first = compileAreaEvidenceMatrix(input());
  const secondInput = input();
  secondInput.comparisons.reverse();
  secondInput.comparisons.forEach((entry) => {
    entry.comparison.models.reverse();
    entry.comparison.models.forEach((model) => model.cases.reverse());
  });
  const second = compileAreaEvidenceMatrix(secondInput);

  assert.equal(first.evidence.length, areaIds.length * models.length);
  assert.match(first.evidenceDigest, /^[a-f0-9]{64}$/u);
  assert.equal(first.evidenceDigest, second.evidenceDigest);
  assert.deepEqual(first.evidence, second.evidence);
  const cell = first.evidence.find(
    (entry) => entry.areaId === "gateway-protocol" && entry.model === "openai/model-a"
  );
  assert.equal(cell?.quality.sampleCount, 5);
  assert.equal(cell?.quality.passRate, 1);
  assert.ok((cell?.quality.lowerConfidenceBound ?? 0) > 0.56);
  assert.ok((cell?.quality.lowerConfidenceBound ?? 1) < 0.57);
  assert.equal(cell?.failureRate, 0);
  assert.equal(cell?.averageJudgeScore, 0.9);
  assert.equal(cell?.p95DurationMs, 140);
  assert.equal(cell?.unpricedCalls, 0);
  assert.equal(cell?.averageCostUsd, 0.012);
});

test("partial pricing is explicit and never converted into a known average", () => {
  const value = input();
  value.comparisons[0]!.comparison.models[0]!.cases = cases({
    unpriced: new Set(["case-4", "case-5"])
  });
  const cell = compileAreaEvidenceMatrix(value).evidence.find(
    (entry) => entry.areaId === areaIds[0] && entry.model === models[0]
  );
  assert.equal(cell?.unpricedCalls, 2);
  assert.equal(cell?.averageCostUsd, undefined);
});

test("partial duration measurements do not produce a misleading percentile", () => {
  const value = input();
  value.comparisons[0]!.comparison.models[0]!.cases = cases({
    missingDuration: new Set(["case-5"])
  });
  const cell = compileAreaEvidenceMatrix(value).evidence.find(
    (entry) => entry.areaId === areaIds[0] && entry.model === models[0]
  );
  assert.equal(cell?.p95DurationMs, undefined);
});

test("matrix compilation rejects missing and duplicate areas or candidates", () => {
  const missingArea = input();
  missingArea.comparisons.pop();
  assert.throws(() => compileAreaEvidenceMatrix(missingArea), /missing area/);

  const duplicateArea = input();
  duplicateArea.comparisons[1] = duplicateArea.comparisons[0]!;
  assert.throws(() => compileAreaEvidenceMatrix(duplicateArea), /duplicate area/);

  const missingCandidate = input();
  missingCandidate.comparisons[0]!.comparison.models.pop();
  assert.throws(() => compileAreaEvidenceMatrix(missingCandidate), /missing candidate/);

  const unexpectedCandidate = input();
  unexpectedCandidate.comparisons[0]!.comparison.models[0]!.model = "openai/unexpected";
  assert.throws(() => compileAreaEvidenceMatrix(unexpectedCandidate), /unexpected candidate/);
});

test("matrix compilation rejects incomplete or ambiguous case evidence", () => {
  const missingCase = input();
  missingCase.comparisons[0]!.comparison.models[0]!.cases.pop();
  assert.throws(() => compileAreaEvidenceMatrix(missingCase), /has 4 cases; expected 5/);

  const duplicateCase = input();
  duplicateCase.comparisons[0]!.comparison.models[0]!.cases[4] =
    duplicateCase.comparisons[0]!.comparison.models[0]!.cases[0]!;
  assert.throws(() => compileAreaEvidenceMatrix(duplicateCase), /duplicate case/);

  const missingJudgeScore = input();
  delete missingJudgeScore.comparisons[0]!.comparison.models[0]!.cases[0]!.measurement.judgeScore;
  assert.throws(() => compileAreaEvidenceMatrix(missingJudgeScore), /missing a judge score/);

  const cutoff = input();
  cutoff.comparisons[0]!.comparison.models[0]!.cases[0]!.outcome = "cutoff";
  assert.throws(() => compileAreaEvidenceMatrix(cutoff), /non-terminal case/);
});

test("matrix compilation binds profile, suite digest, and judge", () => {
  const wrongProfile = input();
  wrongProfile.comparisons[0]!.comparison.profileId = "wrong";
  assert.throws(() => compileAreaEvidenceMatrix(wrongProfile), /does not match area/);

  const wrongDigest = input();
  wrongDigest.comparisons[0]!.comparison.suiteDigest = "wrong";
  assert.throws(() => compileAreaEvidenceMatrix(wrongDigest), /suite digest does not match/);

  const wrongJudge = input();
  wrongJudge.comparisons[0]!.comparison.judgeModel = "openai/wrong";
  assert.throws(() => compileAreaEvidenceMatrix(wrongJudge), /comparison judge does not match/);
});

test("Wilson lower confidence bounds are conservative and validate counts", () => {
  assert.equal(wilsonLowerBound95(0, 5), 0);
  assert.ok(wilsonLowerBound95(5, 5) < 1);
  assert.ok(wilsonLowerBound95(19, 20) < 0.95);
  assert.throws(() => wilsonLowerBound95(6, 5), /within the sample/);
  assert.throws(() => wilsonLowerBound95(0, 0), /within the sample/);
});
