import { writeFileAtomicEffect } from "@velum-labs/routekit-runtime/effect";
import {
  type EvalComparisonResult,
  EvalComparisonResult as EvalComparisonResultSchema
} from "@velum-labs/routekit-eval-contracts";
import { Clock, Context, Effect, FileSystem, Layer, Path, Ref, Schema, Semaphore } from "effect";

import {
  TESTDRIVE_SCHEMA_VERSION,
  type TestdriveCleanupOutcome,
  type TestdriveEvent,
  TestdriveEvent as TestdriveEventSchema,
  TestdriveEvidenceError,
  type TestdriveFailsafes,
  type TestdriveProfileReport,
  type TestdriveReport,
  TestdriveReport as TestdriveReportSchema,
  type TestdriveRoutingDecision
} from "./contracts.js";
import { TestdriveLedger } from "./ledger.js";

export type TestdriveEventInput = Omit<
  TestdriveEvent,
  "runId" | "sequence" | "timestamp" | "version"
>;

export type TestdriveProfileArtifactPaths = Readonly<{
  evalDirectory: string;
  routingProfilePath: string;
  comparisonPath: string;
}>;

export const testdriveProfileArtifactPaths = (
  profileId: string
): TestdriveProfileArtifactPaths => ({
  evalDirectory: `profiles/${profileId}/eval`,
  routingProfilePath: `profiles/${profileId}/routing-profile.yaml`,
  comparisonPath: `profiles/${profileId}/comparison.json`
});

export interface TestdriveEvidenceService {
  readonly artifactDirectory: string;
  readonly emit: (
    event: TestdriveEventInput
  ) => Effect.Effect<TestdriveEvent, TestdriveEvidenceError>;
  readonly events: Effect.Effect<readonly TestdriveEvent[]>;
  readonly writeGeneratedSuite: (input: {
    readonly profileId: string;
    readonly evalSource: string;
    readonly casesJson: string;
    readonly manifestJson: string;
    readonly routingProfileYaml: string;
  }) => Effect.Effect<TestdriveProfileArtifactPaths, TestdriveEvidenceError>;
  readonly writeComparison: (
    profileId: string,
    comparison: EvalComparisonResult
  ) => Effect.Effect<string, TestdriveEvidenceError>;
  readonly writeReport: (input: {
    readonly startedAt: string;
    readonly status: "passed" | "failed";
    readonly models: readonly string[];
    readonly profiles: readonly TestdriveProfileReport[];
    readonly routingDecisions: readonly TestdriveRoutingDecision[];
  }) => Effect.Effect<TestdriveReport, TestdriveEvidenceError>;
}

export class TestdriveEvidence extends Context.Service<
  TestdriveEvidence,
  TestdriveEvidenceService
>()("@velum-labs/routekit-testkit/TestdriveEvidence") {}

const jsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;
const SAFE_PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/u;

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
        profileId: string
      ): Effect.Effect<TestdriveProfileArtifactPaths, TestdriveEvidenceError> =>
        SAFE_PROFILE_ID.test(profileId)
          ? Effect.succeed(testdriveProfileArtifactPaths(profileId))
          : Effect.fail(
              new TestdriveEvidenceError({
                detail: "cannot write profile artifacts for an unsafe profile id"
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
          const artifactPaths = yield* requireArtifactPaths(input.profileId);
          yield* fs.makeDirectory(
            paths.join(options.artifactDirectory, artifactPaths.evalDirectory, "data"),
            { recursive: true, mode: 0o700 }
          );
          yield* writeArtifact(
            paths.join(artifactPaths.evalDirectory, `${input.profileId}.eval.ts`),
            input.evalSource
          );
          yield* writeArtifact(
            paths.join(artifactPaths.evalDirectory, "data", "cases.json"),
            input.casesJson
          );
          yield* writeArtifact(
            paths.join(artifactPaths.evalDirectory, "routekit.eval-manifest.json"),
            input.manifestJson
          );
          yield* writeArtifact(artifactPaths.routingProfilePath, input.routingProfileYaml);
          return artifactPaths;
        }).pipe(
          Effect.mapError(
            (cause) =>
              cause instanceof TestdriveEvidenceError
                ? cause
                : new TestdriveEvidenceError({
                    detail: "failed to retain generated eval suite",
                    cause
                  })
          )
        );
      const writeComparison: TestdriveEvidenceService["writeComparison"] = (
        profileId,
        comparison
      ) =>
        Effect.gen(function* () {
          const artifactPaths = yield* requireArtifactPaths(profileId);
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
          Effect.mapError(
            (cause) =>
              cause instanceof TestdriveEvidenceError
                ? cause
                : new TestdriveEvidenceError({
                    detail: "failed to retain structured comparison result",
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
                ...(event.profileId === undefined ? {} : { profileId: event.profileId }),
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
            profiles: [...input.profiles],
            routingDecisions: [...input.routingDecisions],
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
