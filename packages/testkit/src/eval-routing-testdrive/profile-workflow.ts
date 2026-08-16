import { EvalSetup } from "@velum-labs/routekit-eval-setup";
import { Context, Effect, Exit, Layer } from "effect";

import { type TestdriveProfileReport, TestdriveWorkflowError } from "./contracts.js";
import { TestdriveEvidence } from "./evidence.js";
import { TestdriveOperatorAgent } from "./operator-agent.js";

export type TestdriveProfileInput = Readonly<{
  profileId: string;
  description: string;
  brief: string;
  candidates: readonly string[];
  repositoryRoot: string;
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

export const TestdriveProfileDriverLive: Layer.Layer<
  TestdriveProfileDriver,
  never,
  EvalSetup | TestdriveEvidence | TestdriveOperatorAgent
> = Layer.effect(
  TestdriveProfileDriver,
  Effect.gen(function* () {
    const setup = yield* EvalSetup;
    const evidence = yield* TestdriveEvidence;
    const operator = yield* TestdriveOperatorAgent;
    const drive: TestdriveProfileDriverService["drive"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* setup.prepare(input.repositoryRoot, input.profileId, {
          description: input.description
        });
        yield* evidence.emit({
          type: "profile-transition",
          phase: "prepare",
          profileId: input.profileId,
          status: prepared.state.stage
        });
        let completed = false;
        let turns = 0;
        while (!completed && turns < 30) {
          turns += 1;
          const current = yield* setup.runApproved(input.repositoryRoot, input.profileId);
          yield* evidence.emit({
            type: "profile-transition",
            phase: "authoring",
            profileId: input.profileId,
            status: current.state.stage
          });
          if (current.state.stage === "completed") {
            completed = true;
            break;
          }
          const question = current.question;
          if (question === undefined) {
            return yield* new TestdriveWorkflowError({
              phase: "authoring",
              detail: `${input.profileId} authoring returned no setup question`
            });
          }
          const answer = yield* operator.answer({
            profileId: input.profileId,
            profileBrief: [
              input.brief,
              `Profile description: ${input.description}`,
              `Candidate models: ${input.candidates.join(", ")}`
            ].join("\n"),
            question: question.prompt,
            options: question.options
          });
          const accepted = yield* setup.answer(input.repositoryRoot, input.profileId, answer);
          if (accepted.state.stage !== "prepared") {
            return yield* new TestdriveWorkflowError({
              phase: "authoring",
              detail: `${input.profileId} answer did not stop at an explicit prepared checkpoint`
            });
          }
          // These become valid as soon as the author has materialized the
          // self-contained suite and structured run manifest.
          const validation = yield* Effect.exit(
            setup.validate(input.repositoryRoot, input.profileId)
          );
          if (Exit.isSuccess(validation)) {
            const estimate = yield* setup.estimate(input.repositoryRoot, input.profileId, "pilot");
            if (estimate.callCount <= 0) {
              return yield* new TestdriveWorkflowError({
                phase: "estimate",
                detail: `${input.profileId} prospective estimate reported no model calls`
              });
            }
            yield* evidence.emit({
              type: "phase-finished",
              phase: "comparison-ready",
              profileId: input.profileId,
              status: String(estimate.callCount)
            });
          }
        }
        if (!completed) {
          return yield* new TestdriveWorkflowError({
            phase: "authoring",
            detail: `${input.profileId} exceeded 30 bounded author turns`
          });
        }
        const published = yield* setup.publishApproved(input.repositoryRoot, input.profileId);
        const proposal = published.proposal;
        if (
          proposal === undefined ||
          proposal.profileId !== input.profileId ||
          proposal.description === undefined
        ) {
          return yield* new TestdriveWorkflowError({
            phase: "publish",
            detail: `${input.profileId} publish omitted a complete compiled policy`
          });
        }
        const observedModels = new Set(proposal.evidence.map((entry) => entry.model));
        if (
          observedModels.size !== input.candidates.length ||
          input.candidates.some((model) => !observedModels.has(model)) ||
          proposal.evidence.some(
            (entry) =>
              entry.sampleCount < 1 ||
              entry.passRate === undefined ||
              entry.averageJudgeScore === undefined ||
              entry.averageCostUsd === undefined
          )
        ) {
          return yield* new TestdriveWorkflowError({
            phase: "publish",
            detail: `${input.profileId} comparison did not completely measure the proposed candidate slate`
          });
        }
        const report: TestdriveProfileReport = {
          profileId: proposal.profileId,
          description: proposal.description,
          selectedModel: proposal.selectedModel,
          fallbackModels: proposal.fallbackModels,
          suiteDigest: proposal.suiteDigest,
          evidenceDigest: proposal.evidenceDigest
        };
        yield* evidence.emit({
          type: "snapshot-published",
          phase: "publish",
          profileId: input.profileId,
          model: report.selectedModel,
          status: "published"
        });
        return report;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof TestdriveWorkflowError
            ? cause
            : new TestdriveWorkflowError({
                phase: "profile",
                detail: `${input.profileId} profile workflow failed`,
                cause
              })
        ),
        Effect.withSpan("EvalRoutingTestdrive.profile", {
          attributes: { profileId: input.profileId }
        })
      );
    return TestdriveProfileDriver.of({ drive });
  })
);
