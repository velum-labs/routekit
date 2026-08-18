import {
  type EvalComparisonResult,
  EvalComparisonResult as EvalComparisonResultSchema,
  type PublishedRoutingActivation,
  PublishedRoutingActivation as PublishedRoutingActivationSchema
} from "@velum-labs/routekit-eval-contracts";
import { writeFileAtomicEffect } from "@velum-labs/routekit-runtime/effect";
import { Clock, Context, Effect, FileSystem, Layer, Path, Ref, Schema, Semaphore } from "effect";

import {
  CLASSIFIER_QUALIFICATION_SCHEMA_VERSION,
  type ClassifierQualificationReport
} from "../eval-routing-compositional/qualification.js";
import {
  TESTDRIVE_SCHEMA_VERSION,
  type TestdriveClassifierQualification,
  type TestdriveCleanupOutcome,
  type TestdriveCompositionalRoutingDecision,
  type TestdriveDimensionMatrixQualification,
  type TestdriveDimensionReport,
  type TestdriveEvent,
  TestdriveEvent as TestdriveEventSchema,
  TestdriveEvidenceError,
  type TestdriveFailsafes,
  type TestdriveReport,
  TestdriveReport as TestdriveReportSchema
} from "./contracts.js";
import { TestdriveLedger } from "./ledger.js";

export type TestdriveEventInput = Omit<
  TestdriveEvent,
  "runId" | "sequence" | "timestamp" | "version"
>;

export type TestdriveDimensionArtifactPaths = Readonly<{
  evalDirectory: string;
  manifestPath: string;
  comparisonPath: string;
}>;

export const testdriveDimensionArtifactPaths = (
  dimensionId: string
): TestdriveDimensionArtifactPaths => ({
  evalDirectory: `dimensions/${dimensionId}/eval`,
  manifestPath: `dimensions/${dimensionId}/eval/routekit.eval-manifest.json`,
  comparisonPath: `dimensions/${dimensionId}/comparison.json`
});

export interface TestdriveEvidenceService {
  readonly artifactDirectory: string;
  readonly emit: (
    event: TestdriveEventInput
  ) => Effect.Effect<TestdriveEvent, TestdriveEvidenceError>;
  readonly events: Effect.Effect<readonly TestdriveEvent[]>;
  readonly writeGeneratedSuite: (input: {
    readonly dimensionId: string;
    readonly evalSource: string;
    readonly casesJson: string;
    readonly manifestJson: string;
  }) => Effect.Effect<TestdriveDimensionArtifactPaths, TestdriveEvidenceError>;
  readonly writeComparison: (
    dimensionId: string,
    comparison: EvalComparisonResult
  ) => Effect.Effect<string, TestdriveEvidenceError>;
  readonly writeDimensionMatrixQualification: (input: {
    readonly snapshot: PublishedRoutingActivation;
    readonly dimensions: readonly TestdriveDimensionReport[];
    readonly casesPerDimension: number;
  }) => Effect.Effect<TestdriveDimensionMatrixQualification, TestdriveEvidenceError>;
  readonly writeClassifierQualification: (
    report: ClassifierQualificationReport
  ) => Effect.Effect<TestdriveClassifierQualification, TestdriveEvidenceError>;
  readonly writeReport: (input: {
    readonly startedAt: string;
    readonly status: "passed" | "failed";
    readonly models: readonly string[];
    readonly dimensionMatrixQualification?: TestdriveDimensionMatrixQualification;
    readonly compositionalRoutingDecisions?: readonly TestdriveCompositionalRoutingDecision[];
    readonly classifierQualification?: TestdriveClassifierQualification;
  }) => Effect.Effect<TestdriveReport, TestdriveEvidenceError>;
}

export class TestdriveEvidence extends Context.Service<
  TestdriveEvidence,
  TestdriveEvidenceService
>()("@velum-labs/routekit-testkit/TestdriveEvidence") {}

const jsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;
const SAFE_DIMENSION_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/u;

export const makeTestdriveEvidenceLayer = (options: {
  readonly artifactDirectory: string;
  readonly failsafes: TestdriveFailsafes;
  readonly revision: string;
  readonly runId: string;
}): Layer.Layer<
  TestdriveEvidence,
  TestdriveEvidenceError,
  FileSystem.FileSystem | Path.Path | TestdriveLedger
> =>
  Layer.effect(
    TestdriveEvidence,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const ledger = yield* TestdriveLedger;
      const events = yield* Ref.make<readonly TestdriveEvent[]>([]);
      const writeLock = yield* Semaphore.make(1);
      yield* fs.makeDirectory(options.artifactDirectory, { recursive: true, mode: 0o700 });
      const eventsPath = `${options.artifactDirectory}/events.jsonl`;
      const reportPath = `${options.artifactDirectory}/report.json`;
      const requireArtifactPaths = (
        dimensionId: string
      ): Effect.Effect<TestdriveDimensionArtifactPaths, TestdriveEvidenceError> =>
        SAFE_DIMENSION_ID.test(dimensionId)
          ? Effect.succeed(testdriveDimensionArtifactPaths(dimensionId))
          : Effect.fail(
              new TestdriveEvidenceError({
                detail: "cannot write dimension artifacts for an unsafe dimension id"
              })
            );
      const writeArtifact = (relativePath: string, contents: string) =>
        writeFileAtomicEffect(paths.join(options.artifactDirectory, relativePath), contents, {
          mode: 0o600
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, paths)
        );
      const writeGeneratedSuite: TestdriveEvidenceService["writeGeneratedSuite"] = (input) =>
        Effect.gen(function* () {
          const artifactPaths = yield* requireArtifactPaths(input.dimensionId);
          yield* fs.makeDirectory(
            paths.join(options.artifactDirectory, artifactPaths.evalDirectory, "data"),
            { recursive: true, mode: 0o700 }
          );
          yield* writeArtifact(
            paths.join(artifactPaths.evalDirectory, `${input.dimensionId}.eval.ts`),
            input.evalSource
          );
          yield* writeArtifact(
            paths.join(artifactPaths.evalDirectory, "data", "cases.json"),
            input.casesJson
          );
          yield* writeArtifact(
            artifactPaths.manifestPath,
            input.manifestJson
          );
          return artifactPaths;
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof TestdriveEvidenceError
              ? cause
              : new TestdriveEvidenceError({
                  detail: "failed to retain generated eval suite",
                  cause
                })
          )
        );
      const writeComparison: TestdriveEvidenceService["writeComparison"] = (
        dimensionId,
        comparison
      ) =>
        Effect.gen(function* () {
          const artifactPaths = yield* requireArtifactPaths(dimensionId);
          yield* fs.makeDirectory(
            paths.dirname(paths.join(options.artifactDirectory, artifactPaths.comparisonPath)),
            { recursive: true, mode: 0o700 }
          );
          const validated = yield* Schema.decodeEffect(EvalComparisonResultSchema)(comparison);
          const sanitized: EvalComparisonResult = {
            ...validated,
            models: validated.models.map((model) => ({
              ...model,
              cases: model.cases.map((testCase) => ({
                caseId: testCase.caseId,
                outcome: testCase.outcome,
                measurement: testCase.measurement
              }))
            }))
          };
          yield* writeArtifact(
            artifactPaths.comparisonPath,
            `${JSON.stringify(sanitized, null, 2)}\n`
          );
          return artifactPaths.comparisonPath;
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof TestdriveEvidenceError
              ? cause
              : new TestdriveEvidenceError({
                  detail: "failed to retain structured comparison result",
                  cause
                })
          )
        );
      const writeDimensionMatrixQualification: TestdriveEvidenceService["writeDimensionMatrixQualification"] =
        (input) =>
          Effect.gen(function* () {
            const snapshot = yield* Schema.decodeEffect(PublishedRoutingActivationSchema)(
              input.snapshot
            );
            if (
              !Number.isSafeInteger(input.casesPerDimension) ||
              input.casesPerDimension < 1 ||
              snapshot.evidence.some(
                (cell) => cell.quality.sampleCount !== input.casesPerDimension
              ) ||
              input.dimensions.length !== snapshot.dimensions.length ||
              input.dimensions.some(
                (dimension, index) =>
                  dimension.dimensionId !== snapshot.dimensions[index]?.id ||
                  !snapshot.evidence.some(
                    (cell) =>
                      cell.dimensionId === dimension.dimensionId &&
                      cell.suiteDigest === dimension.suiteDigest
                  )
              )
            ) {
              return yield* new TestdriveEvidenceError({
                detail: "dimension-matrix report does not match the published routing activation"
              });
            }
            const snapshotPath = "published-routing.json";
            yield* writeArtifact(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
            return {
              qualificationTier: "testdrive" as const,
              basisDigest: snapshot.basisDigest,
              evidenceDigest: snapshot.evidenceDigest,
              snapshotPath,
              candidateCount: snapshot.candidateModels.length,
              dimensionCount: snapshot.dimensions.length,
              casesPerDimension: input.casesPerDimension,
              dimensions: [...input.dimensions]
            };
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof TestdriveEvidenceError
                ? cause
                : new TestdriveEvidenceError({
                    detail: "failed to retain compositional dimension-matrix evidence",
                    cause
                  })
            )
          );
      const writeClassifierQualification: TestdriveEvidenceService["writeClassifierQualification"] =
        (report) =>
          Effect.gen(function* () {
            if (report.schemaVersion !== CLASSIFIER_QUALIFICATION_SCHEMA_VERSION) {
              return yield* new TestdriveEvidenceError({
                detail: "classifier qualification report has an unsupported schema version"
              });
            }
            const reportPath = "decomposition-qualification.json";
            yield* writeArtifact(reportPath, `${JSON.stringify(report, null, 2)}\n`);
            return {
              basisDigest: report.basisDigest,
              passed: report.passed,
              expectedCaseCount: report.expectedCaseCount,
              observedCaseCount: report.observedCaseCount,
              validVectorCount: report.validVectorCount,
              ...(report.meanVectorL1Error === undefined
                ? {}
                : { meanVectorL1Error: report.meanVectorL1Error }),
              ...(report.maximumVectorL1Error === undefined
                ? {}
                : { maximumVectorL1Error: report.maximumVectorL1Error }),
              reportPath
            };
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof TestdriveEvidenceError
                ? cause
                : new TestdriveEvidenceError({
                    detail: "failed to write classifier qualification report",
                    cause
                  })
            )
          );
      const emit: TestdriveEvidenceService["emit"] = (input) =>
        writeLock.withPermit(
          Effect.gen(function* () {
            const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
            const current = yield* Ref.get(events);
            const event = yield* Schema.decodeEffect(TestdriveEventSchema)({
              ...input,
              version: TESTDRIVE_SCHEMA_VERSION,
              sequence: current.length + 1,
              timestamp,
              runId: options.runId
            });
            const next = [...current, event];
            yield* Ref.set(events, next);
            yield* fs.writeFileString(eventsPath, next.map(jsonLine).join(""), { mode: 0o600 });
            yield* Effect.logInfo(event.type).pipe(
              Effect.annotateLogs({
                runId: event.runId,
                sequence: event.sequence,
                ...(event.phase === undefined ? {} : { phase: event.phase }),
                ...(event.dimensionId === undefined ? {} : { dimensionId: event.dimensionId }),
                ...(event.model === undefined ? {} : { model: event.model }),
                ...(event.failureCode === undefined ? {} : { failureCode: event.failureCode })
              })
            );
            return event;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new TestdriveEvidenceError({
                  detail: "failed to append structured testdrive event",
                  cause
                })
            )
          )
        );
      const writeReport: TestdriveEvidenceService["writeReport"] = (input) =>
        Effect.gen(function* () {
          if (input.status === "passed" && input.classifierQualification?.passed === false) {
            return yield* new TestdriveEvidenceError({
              detail: "passing testdrive report cannot contain a failed classifier qualification"
            });
          }
          const recorded = yield* Ref.get(events);
          const cleanup = recorded.flatMap((event) =>
            event.type === "cleanup-finished" &&
            event.phase !== undefined &&
            (event.status === "closed" || event.status === "failed" || event.status === "passed")
              ? [
                  {
                    phase: event.phase,
                    status: event.status
                  } satisfies TestdriveCleanupOutcome
                ]
              : []
          );
          const report: TestdriveReport = {
            version: TESTDRIVE_SCHEMA_VERSION,
            runId: options.runId,
            revision: options.revision,
            startedAt: input.startedAt,
            finishedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
            status: input.status,
            failsafes: options.failsafes,
            ledger: yield* ledger.snapshot,
            models: [...new Set(input.models)],
            ...(input.dimensionMatrixQualification === undefined
              ? {}
              : { dimensionMatrixQualification: input.dimensionMatrixQualification }),
            compositionalRoutingDecisions: [...(input.compositionalRoutingDecisions ?? [])],
            ...(input.classifierQualification === undefined
              ? {}
              : { classifierQualification: input.classifierQualification }),
            cleanup,
            eventCount: recorded.length
          };
          const validated = yield* Schema.decodeEffect(TestdriveReportSchema)(report);
          yield* writeFileAtomicEffect(reportPath, `${JSON.stringify(validated, null, 2)}\n`, {
            mode: 0o600
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, paths)
          );
          return validated;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new TestdriveEvidenceError({
                detail: "failed to write structured testdrive report",
                cause
              })
          )
        );
      return TestdriveEvidence.of({
        artifactDirectory: options.artifactDirectory,
        emit,
        events: Ref.get(events),
        writeGeneratedSuite,
        writeComparison,
        writeDimensionMatrixQualification,
        writeClassifierQualification,
        writeReport
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TestdriveEvidenceError({
            detail: "failed to initialize structured testdrive evidence",
            cause
          })
      )
    )
  );
