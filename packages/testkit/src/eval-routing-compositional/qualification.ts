import { createHash } from "node:crypto";

import {
  assertDecompositionResult,
  assertRoutingBasis,
  COMPOSITIONAL_ROUTING_VERSION,
  type DecompositionResult,
  DecompositionResult as DecompositionResultSchema,
  REQUEST_DECOMPOSITION_TOLERANCE,
  type RoutingBasis
} from "@velum-labs/routekit-eval-contracts";
import { ClassificationError, type RequestDecomposerService } from "@velum-labs/routekit-gateway";
import { Data, Effect, Schema } from "effect";

export const CLASSIFIER_QUALIFICATION_SCHEMA_VERSION = 1 as const;

export type ClassifierBenchmarkCaseKind =
  | "single-dimension"
  | "composite"
  | "boundary"
  | "unknown"
  | "prompt-injection";

export type ClassifierBenchmarkTarget = Readonly<{
  weights: Readonly<Record<string, number>>;
  unknownWeight: number;
}>;

export type ClassifierBenchmarkCase = Readonly<{
  id: string;
  kind: ClassifierBenchmarkCaseKind;
  request: string;
  expected: ClassifierBenchmarkTarget;
  /** A known basis dimension that an injection asks the classifier to force. */
  forcedDimensionId?: string;
}>;

export type ClassifierQualificationThresholds = Readonly<{
  singleDimensionDominantMinimum: number;
  unknownCaseMinimumUnknownWeight: number;
  promptInjectionMaximumForcedDimensionWeight: number;
  maximumVectorL1Error: number;
  sumTolerance: number;
}>;

export type ClassifierBenchmark = Readonly<{
  basisDigest: string;
  dimensionOrder: readonly string[];
  cases: readonly ClassifierBenchmarkCase[];
  scoring: ClassifierQualificationThresholds;
}>;

export type RoutingBasisFixture = Readonly<{
  schemaVersion: 1;
  basisId: string;
  basisVersion: number;
  dimensions: readonly Readonly<{
    id: string;
    definition: string;
    includes: readonly string[];
    excludes: readonly string[];
  }>[];
}>;

export type ClassifierQualificationObservation =
  | Readonly<{
      caseId: string;
      result: unknown;
      classifierCallId?: string;
    }>
  | Readonly<{
      caseId: string;
      failure: "classifier_call_failed";
      failureReason: ClassifierQualificationCallFailureReason;
    }>;

export type ClassifierQualificationCallFailureReason =
  | "request-failed"
  | "http-error"
  | "response-not-json"
  | "response-not-single-json"
  | "malformed-vector"
  | "invalid-vector"
  | "invalid-input"
  | "unknown";

export type ClassifierQualificationFailureCode =
  | "duplicate_observation"
  | "classifier_call_failed"
  | "invalid_vector"
  | "missing_observation"
  | "vector_error_above_maximum"
  | "dominant_dimension_below_minimum"
  | "unknown_weight_below_minimum"
  | "injection_followed";

export type ClassifierQualificationVector = Readonly<{
  weights: readonly Readonly<{
    dimensionId: string;
    weight: number;
  }>[];
  unknownWeight: number;
}>;

export type ClassifierQualificationCaseReport = Readonly<{
  caseId: string;
  kind: ClassifierBenchmarkCaseKind;
  passed: boolean;
  expected: ClassifierQualificationVector;
  observed?: ClassifierQualificationVector;
  callFailureReason?: ClassifierQualificationCallFailureReason;
  vectorL1Error?: number;
  classifierCallId?: string;
  failures: readonly ClassifierQualificationFailureCode[];
}>;

export type ClassifierQualificationReport = Readonly<{
  schemaVersion: typeof CLASSIFIER_QUALIFICATION_SCHEMA_VERSION;
  basisDigest: string;
  passed: boolean;
  expectedCaseCount: number;
  observedCaseCount: number;
  validVectorCount: number;
  meanVectorL1Error?: number;
  maximumVectorL1Error?: number;
  cases: readonly ClassifierQualificationCaseReport[];
  unexpectedCaseIds: readonly string[];
}>;

export class ClassifierQualificationConfigurationError extends Data.TaggedError(
  "ClassifierQualificationConfigurationError"
)<{
  readonly message: string;
}> {}

const CASE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const CALL_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const REQUIRED_KINDS: readonly ClassifierBenchmarkCaseKind[] = [
  "single-dimension",
  "composite",
  "boundary",
  "unknown",
  "prompt-injection"
];

function invalid(message: string): never {
  throw new ClassifierQualificationConfigurationError({ message });
}

function finiteBetween(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} must be a finite number between ${String(minimum)} and ${String(maximum)}`);
  }
}

function validateThresholds(scoring: ClassifierQualificationThresholds): void {
  finiteBetween(scoring.singleDimensionDominantMinimum, 0, 1, "single-dimension dominant minimum");
  finiteBetween(scoring.unknownCaseMinimumUnknownWeight, 0, 1, "unknown-case minimum");
  finiteBetween(
    scoring.promptInjectionMaximumForcedDimensionWeight,
    0,
    1,
    "prompt-injection forced-dimension maximum"
  );
  finiteBetween(scoring.maximumVectorL1Error, 0, 2, "maximum vector L1 error");
  if (scoring.sumTolerance !== REQUEST_DECOMPOSITION_TOLERANCE) {
    invalid("benchmark sum tolerance must match the routing contract");
  }
}

/**
 * Converts the reviewed basis fixture into the exact classifier contract and
 * binds it to a deterministic digest of the definitions and boundaries.
 */
export function routingBasisFromFixture(fixture: RoutingBasisFixture): RoutingBasis {
  if (
    fixture.schemaVersion !== 1 ||
    fixture.basisId.length === 0 ||
    fixture.basisId !== fixture.basisId.trim() ||
    !Number.isSafeInteger(fixture.basisVersion) ||
    fixture.basisVersion < 1
  ) {
    invalid("routing dimension basis fixture has invalid identity metadata");
  }
  const dimensions = fixture.dimensions.map((dimension) => ({
    id: dimension.id,
    description: dimension.definition,
    includes: dimension.includes,
    excludes: dimension.excludes
  }));
  const basisDigest = createHash("sha256")
    .update(
      JSON.stringify({
        version: COMPOSITIONAL_ROUTING_VERSION,
        dimensions
      })
    )
    .digest("hex");
  const basis: RoutingBasis = {
    version: COMPOSITIONAL_ROUTING_VERSION,
    basisDigest,
    dimensions
  };
  try {
    assertRoutingBasis(basis);
  } catch {
    invalid("routing dimension basis fixture is invalid");
  }
  return basis;
}

function targetAsResult(
  target: ClassifierBenchmarkTarget,
  dimensionOrder: readonly string[]
): DecompositionResult {
  return {
    weights: dimensionOrder.map((dimensionId) => ({
      dimensionId,
      weight: target.weights[dimensionId] as number
    })),
    unknownWeight: target.unknownWeight
  };
}

function reportVector(
  result: DecompositionResult,
  dimensionOrder: readonly string[]
): ClassifierQualificationVector {
  const byDimension = new Map(result.weights.map((entry) => [entry.dimensionId, entry.weight]));
  return {
    weights: dimensionOrder.map((dimensionId) => ({
      dimensionId,
      weight: byDimension.get(dimensionId) as number
    })),
    unknownWeight: result.unknownWeight
  };
}

function validateBenchmark(basis: RoutingBasis, benchmark: ClassifierBenchmark): void {
  if (benchmark.basisDigest !== basis.basisDigest) {
    invalid("benchmark definition-set digest does not match the basis");
  }
  const catalogDimensionIds = basis.dimensions.map((dimension) => dimension.id);
  if (
    benchmark.dimensionOrder.length !== catalogDimensionIds.length ||
    benchmark.dimensionOrder.some(
      (dimensionId, index) => dimensionId !== catalogDimensionIds[index]
    )
  ) {
    invalid("benchmark dimension order must exactly match the basis");
  }
  validateThresholds(benchmark.scoring);
  if (benchmark.cases.length === 0) invalid("classifier benchmark must contain cases");

  const caseIds = new Set<string>();
  const kinds = new Set<ClassifierBenchmarkCaseKind>();
  const basisDimensionIdSet = new Set(catalogDimensionIds);
  for (const benchmarkCase of benchmark.cases) {
    if (!CASE_ID_PATTERN.test(benchmarkCase.id)) invalid("benchmark contains an invalid case id");
    if (
      benchmarkCase.request.length === 0 ||
      benchmarkCase.request !== benchmarkCase.request.trim() ||
      benchmarkCase.request.length > 4_000
    ) {
      invalid(`benchmark case ${benchmarkCase.id} has an invalid request`);
    }
    if (caseIds.has(benchmarkCase.id)) invalid(`duplicate benchmark case id: ${benchmarkCase.id}`);
    caseIds.add(benchmarkCase.id);
    kinds.add(benchmarkCase.kind);

    const targetDimensionIds = Object.keys(benchmarkCase.expected.weights);
    if (
      targetDimensionIds.length !== catalogDimensionIds.length ||
      catalogDimensionIds.some(
        (dimensionId) => !Object.hasOwn(benchmarkCase.expected.weights, dimensionId)
      ) ||
      targetDimensionIds.some((dimensionId) => !basisDimensionIdSet.has(dimensionId))
    ) {
      invalid(`benchmark case ${benchmarkCase.id} must target every basis dimension exactly once`);
    }
    try {
      assertDecompositionResult(targetAsResult(benchmarkCase.expected, catalogDimensionIds), basis);
    } catch {
      invalid(`benchmark case ${benchmarkCase.id} has an invalid target vector`);
    }

    if (benchmarkCase.forcedDimensionId !== undefined) {
      if (benchmarkCase.kind !== "prompt-injection") {
        invalid(
          `benchmark case ${benchmarkCase.id} sets forcedDimensionId but is not prompt-injection`
        );
      }
      if (!basisDimensionIdSet.has(benchmarkCase.forcedDimensionId)) {
        invalid(`benchmark case ${benchmarkCase.id} has an unknown forced dimension`);
      }
    }
  }
  for (const kind of REQUIRED_KINDS) {
    if (!kinds.has(kind)) invalid(`classifier benchmark has no ${kind} case`);
  }
}

function decodeObservation(result: unknown, basis: RoutingBasis): DecompositionResult | undefined {
  try {
    const decoded = Schema.decodeUnknownSync(DecompositionResultSchema)(result);
    assertDecompositionResult(decoded, basis);
    return decoded;
  } catch {
    return undefined;
  }
}

function weightMap(result: DecompositionResult): ReadonlyMap<string, number> {
  return new Map(result.weights.map((entry) => [entry.dimensionId, entry.weight] as const));
}

function sanitizedCallId(value: string | undefined): string | undefined {
  return value !== undefined && CALL_ID_PATTERN.test(value) ? value : undefined;
}

function sanitizedFailureReason(cause: unknown): ClassifierQualificationCallFailureReason {
  if (!(cause instanceof ClassificationError)) return "unknown";
  const message = cause.message;
  if (message === "dimension classifier model request failed") return "request-failed";
  if (message.startsWith("dimension classifier model request failed with HTTP "))
    return "http-error";
  if (message === "dimension classifier model response was not JSON") return "response-not-json";
  if (message === "dimension classifier response was not exactly one JSON value") {
    return "response-not-single-json";
  }
  if (message === "dimension classifier returned a malformed decomposition vector") {
    return "malformed-vector";
  }
  if (message === "dimension classifier returned an invalid decomposition vector") {
    return "invalid-vector";
  }
  if (
    message === "dimension classifier received malformed input" ||
    message === "dimension classifier received an invalid dimension basis"
  ) {
    return "invalid-input";
  }
  return "unknown";
}

function vectorL1Error(
  actual: DecompositionResult,
  expected: ClassifierBenchmarkTarget,
  dimensionOrder: readonly string[]
): number {
  const actualByDimension = weightMap(actual);
  return (
    dimensionOrder.reduce(
      (sum, dimensionId) =>
        sum +
        Math.abs(
          (actualByDimension.get(dimensionId) as number) - (expected.weights[dimensionId] as number)
        ),
      0
    ) + Math.abs(actual.unknownWeight - expected.unknownWeight)
  );
}

function dominantExpectedDimension(
  benchmarkCase: ClassifierBenchmarkCase,
  dimensionOrder: readonly string[]
): string {
  let dominant = dimensionOrder[0] as string;
  for (const dimensionId of dimensionOrder.slice(1)) {
    if (
      (benchmarkCase.expected.weights[dimensionId] as number) >
      (benchmarkCase.expected.weights[dominant] as number)
    ) {
      dominant = dimensionId;
    }
  }
  return dominant;
}

/**
 * Scores one complete set of live classifier observations without retaining
 * requests, raw model output, or free-form rationale in the returned report.
 */
export function qualifyDimensionClassifier(
  input: Readonly<{
    basis: RoutingBasis;
    benchmark: ClassifierBenchmark;
    observations: readonly ClassifierQualificationObservation[];
  }>
): ClassifierQualificationReport {
  validateBenchmark(input.basis, input.benchmark);

  const expectedById = new Map(input.benchmark.cases.map((entry) => [entry.id, entry] as const));
  const observationsById = new Map<string, ClassifierQualificationObservation>();
  const duplicateIds = new Set<string>();
  const unexpectedIds = new Set<string>();
  for (const observation of input.observations) {
    if (!expectedById.has(observation.caseId)) {
      unexpectedIds.add(observation.caseId);
      continue;
    }
    if (observationsById.has(observation.caseId)) {
      duplicateIds.add(observation.caseId);
      continue;
    }
    observationsById.set(observation.caseId, observation);
  }

  const l1Errors: number[] = [];
  let validVectorCount = 0;
  const cases = input.benchmark.cases.map((benchmarkCase): ClassifierQualificationCaseReport => {
    const failures: ClassifierQualificationFailureCode[] = [];
    const expected = reportVector(
      targetAsResult(benchmarkCase.expected, input.benchmark.dimensionOrder),
      input.benchmark.dimensionOrder
    );
    if (duplicateIds.has(benchmarkCase.id)) failures.push("duplicate_observation");
    const observation = observationsById.get(benchmarkCase.id);
    if (observation === undefined) {
      failures.push("missing_observation");
      return {
        caseId: benchmarkCase.id,
        kind: benchmarkCase.kind,
        passed: false,
        expected,
        failures
      };
    }
    if ("failure" in observation) {
      failures.push("classifier_call_failed");
      return {
        caseId: benchmarkCase.id,
        kind: benchmarkCase.kind,
        passed: false,
        expected,
        callFailureReason: observation.failureReason,
        failures
      };
    }
    const actual = decodeObservation(observation.result, input.basis);
    if (actual === undefined) {
      failures.push("invalid_vector");
      return {
        caseId: benchmarkCase.id,
        kind: benchmarkCase.kind,
        passed: false,
        expected,
        failures
      };
    }

    validVectorCount += 1;
    const l1Error = vectorL1Error(actual, benchmarkCase.expected, input.benchmark.dimensionOrder);
    l1Errors.push(l1Error);
    if (l1Error > input.benchmark.scoring.maximumVectorL1Error) {
      failures.push("vector_error_above_maximum");
    }
    const actualByDimension = weightMap(actual);
    if (benchmarkCase.kind === "single-dimension") {
      const dominantDimension = dominantExpectedDimension(
        benchmarkCase,
        input.benchmark.dimensionOrder
      );
      if (
        (actualByDimension.get(dominantDimension) as number) <
        input.benchmark.scoring.singleDimensionDominantMinimum
      ) {
        failures.push("dominant_dimension_below_minimum");
      }
    }
    if (
      benchmarkCase.kind === "unknown" &&
      actual.unknownWeight < input.benchmark.scoring.unknownCaseMinimumUnknownWeight
    ) {
      failures.push("unknown_weight_below_minimum");
    }
    if (
      benchmarkCase.kind === "prompt-injection" &&
      benchmarkCase.forcedDimensionId !== undefined &&
      (actualByDimension.get(benchmarkCase.forcedDimensionId) as number) >
        input.benchmark.scoring.promptInjectionMaximumForcedDimensionWeight
    ) {
      failures.push("injection_followed");
    }
    const classifierCallId = sanitizedCallId(observation.classifierCallId);
    return {
      caseId: benchmarkCase.id,
      kind: benchmarkCase.kind,
      passed: failures.length === 0,
      expected,
      observed: reportVector(actual, input.benchmark.dimensionOrder),
      vectorL1Error: l1Error,
      ...(classifierCallId === undefined ? {} : { classifierCallId }),
      failures
    };
  });

  const unexpectedCaseIds = [
    ...new Set(
      [...unexpectedIds].map((caseId) =>
        CASE_ID_PATTERN.test(caseId) ? caseId : "invalid-observation-id"
      )
    )
  ].sort();
  const errorTotal = l1Errors.reduce((sum, value) => sum + value, 0);
  return {
    schemaVersion: CLASSIFIER_QUALIFICATION_SCHEMA_VERSION,
    basisDigest: input.basis.basisDigest,
    passed: cases.every((entry) => entry.passed) && unexpectedCaseIds.length === 0,
    expectedCaseCount: input.benchmark.cases.length,
    observedCaseCount: input.observations.length,
    validVectorCount,
    ...(l1Errors.length === 0
      ? {}
      : {
          meanVectorL1Error: errorTotal / l1Errors.length,
          maximumVectorL1Error: Math.max(...l1Errors)
        }),
    cases,
    unexpectedCaseIds
  };
}

/**
 * Executes a benchmark against a real classifier service and converts every
 * failed call into explicit, sanitized qualification evidence.
 */
export function runDimensionClassifierQualification(
  input: Readonly<{
    basis: RoutingBasis;
    benchmark: ClassifierBenchmark;
    classifier: RequestDecomposerService;
  }>
): Effect.Effect<ClassifierQualificationReport, ClassifierQualificationConfigurationError> {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => validateBenchmark(input.basis, input.benchmark),
      catch: (cause) =>
        cause instanceof ClassifierQualificationConfigurationError
          ? cause
          : new ClassifierQualificationConfigurationError({
              message: "classifier qualification configuration is invalid"
            })
    });
    const observations = yield* Effect.forEach(
      input.benchmark.cases,
      (benchmarkCase): Effect.Effect<ClassifierQualificationObservation> =>
        input.classifier
          .classify({
            request: benchmarkCase.request,
            dimensions: input.basis.dimensions
          })
          .pipe(
            Effect.match({
              onFailure: (cause) => ({
                caseId: benchmarkCase.id,
                failure: "classifier_call_failed" as const,
                failureReason: sanitizedFailureReason(cause)
              }),
              onSuccess: (result) => ({
                caseId: benchmarkCase.id,
                result,
                ...(result.classifierCallId === undefined
                  ? {}
                  : { classifierCallId: result.classifierCallId })
              })
            })
          ),
      { concurrency: 1 }
    );
    return qualifyDimensionClassifier({
      basis: input.basis,
      benchmark: input.benchmark,
      observations
    });
  });
}
