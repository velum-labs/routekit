import {
  assertExplicitEvalModel,
  EVAL_CONTRACT_VERSION,
  type EvalCaseResult,
  type EvalRunResult,
  type EvalSuiteSpec
} from "@velum-labs/routekit-eval-contracts";
import { randomId } from "@velum-labs/routekit-runtime";
import { toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Clock, Effect, Exit } from "effect";
import { HttpClient } from "effect/unstable/http";

import { completeEvalChat, type EvalEgressOptions } from "./egress.js";

export function aggregateEvalResults(cases: readonly EvalCaseResult[]): {
  passed: number;
  failed: number;
} {
  const passed = cases.filter((entry) => entry.passed).length;
  return { passed, failed: cases.length - passed };
}

export function runEvalSuite(
  spec: EvalSuiteSpec,
  egress: EvalEgressOptions
): Effect.Effect<EvalRunResult, Error, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        assertExplicitEvalModel(spec.candidateModel, "candidate");
        assertExplicitEvalModel(spec.judgeModel, "judge");
      },
      catch: (cause) => toRouteKitFailure(cause)
    });
    const runId = `eval_${randomId(12)}`;
    const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const cases: EvalCaseResult[] = [];
    for (const testCase of spec.cases) {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const candidateOutput = yield* completeEvalChat({
            egress,
            model: spec.candidateModel,
            role: "candidate",
            runId,
            caseId: testCase.id,
            prompt: testCase.prompt
          });
          const judgeOutput = yield* completeEvalChat({
            egress,
            model: spec.judgeModel,
            role: "judge",
            runId,
            caseId: testCase.id,
            prompt: [
              "Score the candidate answer. Reply with pass or fail.",
              testCase.expected === undefined ? "" : `Expected: ${testCase.expected}`,
              `Answer: ${candidateOutput}`
            ]
              .filter((line) => line.length > 0)
              .join("\n")
          });
          const expectedOk =
            testCase.expected === undefined || candidateOutput.includes(testCase.expected);
          const judgeOk = /\bpass\b/i.test(judgeOutput);
          return {
            caseId: testCase.id,
            candidateOutput,
            judgeOutput,
            passed: expectedOk && judgeOk
          } satisfies EvalCaseResult;
        })
      );
      if (Exit.isSuccess(exit)) {
        cases.push(exit.value);
      } else {
        cases.push({
          caseId: testCase.id,
          candidateOutput: "",
          passed: false,
          error: String(exit.cause)
        });
      }
    }
    const totals = aggregateEvalResults(cases);
    return {
      version: EVAL_CONTRACT_VERSION,
      runId,
      suiteId: spec.id,
      candidateModel: spec.candidateModel,
      judgeModel: spec.judgeModel,
      startedAt,
      finishedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      ...totals,
      cases
    } satisfies EvalRunResult;
  });
}
