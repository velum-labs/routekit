import {
  executeOriAuthoredProfile,
  OriAuthoredProfileExecutionError
} from "@velum-labs/routekit-eval-service";
import { Context, Effect, Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import { type TestdriveProfileReport, TestdriveWorkflowError } from "./contracts.js";
import { testdriveProfileArtifactPaths, TestdriveEvidence } from "./evidence.js";
import type { DiscoveredRoutingProfile } from "./profile-discovery.js";
import { TestdriveSuiteAuthor } from "./suite-author.js";

export type TestdriveProfileInput = Readonly<{
  profile: DiscoveredRoutingProfile;
  candidates: readonly string[];
  repositoryRoot: string;
  judgeModel: string;
}>;

export interface TestdriveProfileDriverService {
  readonly drive: (
    input: TestdriveProfileInput
  ) => Effect.Effect<TestdriveProfileReport, TestdriveWorkflowError>;
}

export class TestdriveProfileDriver extends Context.Service<
  TestdriveProfileDriver,
  TestdriveProfileDriverService
>()("@velum-labs/routekit-testkit/TestdriveProfileDriver") {}

export const makeTestdriveProfileDriverLayer = (options: {
  readonly gatewayUrl: string;
  readonly bearerCredential: string;
  readonly snapshotRoot: string;
}): Layer.Layer<
  TestdriveProfileDriver,
  never,
  HttpClient.HttpClient | TestdriveEvidence | TestdriveSuiteAuthor
> =>
  Layer.effect(
    TestdriveProfileDriver,
    Effect.gen(function* () {
      const evidence = yield* TestdriveEvidence;
      const suiteAuthor = yield* TestdriveSuiteAuthor;
      const httpContext = yield* Effect.context<HttpClient.HttpClient>();
      const drive: TestdriveProfileDriverService["drive"] = (input) =>
        Effect.gen(function* () {
          const authored = yield* suiteAuthor.author({
            profile: input.profile,
            candidateModels: input.candidates,
            judgeModel: input.judgeModel,
            repositoryRoot: input.repositoryRoot
          });
          const executed = yield* executeOriAuthoredProfile({
            profileId: input.profile.id,
            description: input.profile.description,
            repositoryRoot: input.repositoryRoot,
            result: authored,
            gatewayUrl: options.gatewayUrl,
            bearerCredential: options.bearerCredential,
            snapshotRoot: options.snapshotRoot
          }).pipe(
            Effect.provide(httpContext),
            Effect.tapError((cause) => {
              if (
                !(cause instanceof OriAuthoredProfileExecutionError) ||
                cause.evidence === undefined
              ) {
                return cause instanceof OriAuthoredProfileExecutionError &&
                  cause.comparison !== undefined
                  ? evidence.writeComparison(input.profile.id, cause.comparison).pipe(Effect.asVoid)
                  : Effect.void;
              }
              const rejected = new Map(
                (cause.rejected ?? []).map((entry) => [entry.model, entry.reasons] as const)
              );
              const retainComparison =
                cause.comparison === undefined
                  ? Effect.void
                  : evidence.writeComparison(input.profile.id, cause.comparison).pipe(Effect.asVoid);
              return retainComparison.pipe(
                Effect.andThen(
                  Effect.forEach(
                    cause.evidence,
                    (entry) =>
                      evidence.emit({
                        type: "comparison-finished",
                        phase: "comparison",
                        profileId: input.profile.id,
                        model: entry.model,
                        status: rejected.has(entry.model) ? "rejected" : "measured",
                        sampleCount: entry.sampleCount,
                        passedCount: entry.passedCount,
                        failedCount: entry.failedCount,
                        unknownCount: entry.unknownCount,
                        cutoffCount: entry.cutoffCount,
                        ...(entry.passRate === undefined ? {} : { passRate: entry.passRate }),
                        ...(entry.averageJudgeScore === undefined
                          ? {}
                          : { averageJudgeScore: entry.averageJudgeScore }),
                        ...(rejected.has(entry.model)
                          ? { rejectionReasons: [...(rejected.get(entry.model) ?? [])] }
                          : {})
                      }),
                    { discard: true }
                  ).pipe(Effect.ignore)
                )
              );
            })
          );
          const proposal = executed.policy;
          yield* evidence.writeComparison(input.profile.id, executed.comparison);
          const observedModels = new Set(proposal.evidence.map((entry) => entry.model));
          if (
            proposal.description === undefined ||
            observedModels.size !== input.candidates.length ||
            input.candidates.some((model) => !observedModels.has(model)) ||
            proposal.evidence.some(
              (entry) =>
                entry.sampleCount < 1 ||
                entry.passRate === undefined ||
                entry.averageJudgeScore === undefined
            )
          ) {
            return yield* new TestdriveWorkflowError({
              phase: "comparison",
              detail: `${input.profile.id} comparison did not completely measure the proposed candidate slate`
            });
          }
          const report: TestdriveProfileReport = {
            profileId: proposal.profileId,
            description: proposal.description,
            selectedModel: proposal.selectedModel,
            fallbackModels: proposal.fallbackModels,
            suiteDigest: proposal.suiteDigest,
            evidenceDigest: proposal.evidenceDigest,
            artifacts: testdriveProfileArtifactPaths(input.profile.id)
          };
          yield* evidence.emit({
            type: "snapshot-published",
            phase: "publish",
            profileId: input.profile.id,
            model: report.selectedModel,
            status: "published"
          });
          return report;
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof TestdriveWorkflowError
              ? cause
              : cause instanceof OriAuthoredProfileExecutionError
                ? new TestdriveWorkflowError({
                    phase: `authored-${cause.phase}`,
                    detail: cause.detail,
                    cause
                  })
                : new TestdriveWorkflowError({
                    phase: "profile",
                    detail: `${input.profile.id} profile workflow failed`,
                    cause
                  })
          ),
          Effect.withSpan("EvalRoutingTestdrive.profile", {
            attributes: { profileId: input.profile.id }
          })
        );
      return TestdriveProfileDriver.of({ drive });
    })
  );
