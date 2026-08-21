import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Cause, Effect, Layer } from "effect";

import { EvalDimensionContrastError } from "../errors.js";
import { EvalRepositoryInspectorLive } from "../inspection.js";
import { EvalProjectArtifactsLive } from "../project-artifacts.js";
import {
  type EvalExecutionPlan,
  type EvalRunReport,
  summarizeEvalRunLedger
} from "../project-contracts.js";
import { EvalProjectStoreLive } from "../project-store.js";
import { EvalProjectWorkflow, EvalProjectWorkflowLive } from "../project-workflow.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const ProjectDependenciesLive = Layer.mergeAll(
  EvalProjectStoreLive,
  EvalProjectArtifactsLive,
  EvalRepositoryInspectorLive
).pipe(Layer.provide(NodeServicesLayer));

const ProjectWorkflowTestLive = EvalProjectWorkflowLive.pipe(
  Layer.provide(ProjectDependenciesLive),
  Layer.provide(NodeServicesLayer)
);

const makeRepository = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-project-"));
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Example application\n");
  await writeFile(
    path.join(root, "src", "model.ts"),
    'client.responses.create({ model: "openai/current" });\n'
  );
  return root;
};

test("setup creates one durable repository project without invoking model-backed authoring", async () => {
  const root = await makeRepository();
  const first = await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      return yield* workflow.setup(root);
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );

  assert.equal(first.state.stage, "setup-required");
  assert.equal(first.question?.id, "workload-description");
  assert.equal(first.nextAction, "answer");
  assert.deepEqual(first.state.sourceInventory, ["README.md", "src/model.ts"]);

  const resumed = await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      return yield* workflow.setup(root);
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );
  assert.equal(resumed.state.projectId, first.state.projectId);
  assert.equal(resumed.state.revision, 0);

  const projectPath = path.join(root, ".routekit", "evals", "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8")) as {
    readonly stage: string;
    readonly projectId: string;
  };
  assert.equal(project.stage, "setup-required");
  assert.equal(project.projectId, first.state.projectId);
  assert.equal((await stat(projectPath)).mode & 0o777, 0o600);
});

test("answers advance exactly one question and persist a complete compositional configuration", async () => {
  const root = await makeRepository();
  const statuses = await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      yield* workflow.setup(root);
      const workload = yield* workflow.answer(root, "Customer support and documentation requests");
      const candidates = yield* workflow.answer(
        root,
        "openai/gpt-5.6-luna, openai/gpt-5.6-terra openai/gpt-5.6-sol"
      );
      const classifier = yield* workflow.answer(root, "openai/gpt-5.6-luna");
      const author = yield* workflow.answer(root, "openai/gpt-5.6-terra");
      const judge = yield* workflow.answer(root, "openai/gpt-5.6-terra");
      const objective = yield* workflow.answer(root, '{"kind":"highest-quality"}');
      const unknown = yield* workflow.answer(root, "0.2");
      const completed = yield* workflow.answer(root, "{}");
      return { workload, candidates, classifier, author, judge, objective, unknown, completed };
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );

  assert.equal(statuses.workload.question?.id, "candidate-models");
  assert.equal(statuses.workload.state.revision, 1);
  assert.equal(statuses.candidates.question?.id, "classifier-model");
  assert.equal(statuses.classifier.question?.id, "author-model");
  assert.equal(statuses.author.question?.id, "judge-model");
  assert.equal(statuses.judge.question?.id, "routing-objective");
  assert.equal(statuses.objective.question?.id, "maximum-unknown-weight");
  assert.equal(statuses.unknown.question?.id, "routing-constraints");
  assert.equal(statuses.completed.state.stage, "dimensions-review");
  assert.equal(statuses.completed.question, undefined);
  assert.equal(statuses.completed.nextAction, "propose-dimensions");
  if (statuses.completed.state.stage !== "dimensions-review") {
    assert.fail("expected dimensions-review state");
  }
  assert.deepEqual(statuses.completed.state.configuration.candidateModels, [
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-sol"
  ]);
  assert.equal(statuses.completed.state.configuration.classifierModel, "openai/gpt-5.6-luna");
  assert.equal(statuses.completed.state.configuration.authorModel, "openai/gpt-5.6-terra");
  assert.equal(statuses.completed.state.configuration.judgeModel, "openai/gpt-5.6-terra");
  assert.deepEqual(statuses.completed.state.configuration.objective, {
    kind: "highest-quality"
  });
  assert.equal(statuses.completed.state.configuration.maximumUnknownWeight, 0.2);
  assert.equal(statuses.completed.state.configuration.constraints, undefined);

  const resumed = await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      return yield* workflow.status(root);
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );
  assert.equal(resumed?.state.revision, 8);
  assert.equal(resumed?.state.stage, "dimensions-review");
});

test("invalid answers fail without changing the durable project revision", async () => {
  const root = await makeRepository();
  await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      yield* workflow.setup(root);
      const empty = yield* Effect.exit(workflow.answer(root, "   "));
      assert.equal(empty._tag, "Failure");
      const current = yield* workflow.status(root);
      assert.equal(current?.state.revision, 0);
      assert.equal(current?.question?.id, "workload-description");

      yield* workflow.answer(root, "Production workload");
      const duplicateModels = yield* Effect.exit(workflow.answer(root, "openai/one openai/one"));
      assert.equal(duplicateModels._tag, "Failure");
      const afterDuplicate = yield* workflow.status(root);
      assert.equal(afterDuplicate?.state.revision, 1);
      assert.equal(afterDuplicate?.question?.id, "candidate-models");
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );
});

test("corrupt project state preserves the typed project-store failure", async () => {
  const root = await makeRepository();
  await mkdir(path.join(root, ".routekit", "evals"), { recursive: true });
  await writeFile(path.join(root, ".routekit", "evals", "project.json"), "{not-json\n");

  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      return yield* Effect.exit(workflow.status(root));
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );
  assert.equal(exit._tag, "Failure");
  if (exit._tag === "Failure") {
    assert.equal(String(exit.cause).includes("EvalProjectStoreError"), true);
  }
});

const reviewedDimensions = Array.from({ length: 5 }, (_, index) => ({
  id: `dimension-${String(index + 1)}`,
  description: `Production workload dimension ${String(index + 1)}`,
  includes: [`Requests that primarily exercise dimension ${String(index + 1)}`],
  excludes: [`Requests that primarily exercise another dimension`]
}));

const reviewedProposedDimensions = reviewedDimensions.map((dimension, index) => ({
  ...dimension,
  inScopeRequest: `Solve an in-scope request for dimension ${String(index + 1)}.`,
  nearMissRequest: `Solve a neighboring request outside dimension ${String(index + 1)}.`
}));

const reviewedSuites = reviewedDimensions.map((dimension) => ({
  version: 1 as const,
  dimensionId: dimension.id,
  maximumOutputTokens: 256,
  cases: Array.from({ length: 20 }, (_, index) => ({
    id: `${dimension.id}-case-${String(index + 1)}`,
    prompt: `Solve ${dimension.id} case ${String(index + 1)}`,
    rubric: `The response must satisfy ${dimension.id} case ${String(index + 1)}`
  }))
}));

const reviewedDecompositionBenchmark = {
  maximumVectorL1Error: 0.3,
  cases: Array.from({ length: 20 }, (_, index) => ({
    id: `decomposition-case-${String(index + 1)}`,
    request: `Classify production request ${String(index + 1)}`,
    expected: {
      weights: reviewedDimensions.map((dimension, dimensionIndex) => ({
        dimensionId: dimension.id,
        weight: dimensionIndex === index % reviewedDimensions.length ? 1 : 0
      })),
      unknownWeight: 0
    }
  }))
};

const reviewedCompositionSuite = {
  maximumOutputTokens: 256,
  minimumWinnerScoreGap: 0.05,
  minimumWinnerAgreement: 0.8,
  cases: Array.from({ length: 20 }, (_, index) => ({
    id: `composition-case-${String(index + 1)}`,
    prompt: `Solve multi-dimension production case ${String(index + 1)}`,
    rubric: `The response must satisfy multi-dimension case ${String(index + 1)}`,
    decomposition: {
      weights: reviewedDimensions.map((dimension, dimensionIndex) => ({
        dimensionId: dimension.id,
        weight:
          dimensionIndex === index % reviewedDimensions.length ||
          dimensionIndex === (index + 1) % reviewedDimensions.length
            ? 0.5
            : 0
      })),
      unknownWeight: 0
    },
    requirements: {
      endpoint: "responses" as const,
      requiresTools: false,
      requiresVision: false
    }
  }))
};

const reviewedEvaluationInput = {
  suites: reviewedSuites,
  decompositionBenchmark: reviewedDecompositionBenchmark,
  compositionSuite: reviewedCompositionSuite
};

async function completeProjectSetup(root: string): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      yield* workflow.setup(root);
      yield* workflow.answer(root, "Production workload");
      yield* workflow.answer(root, "openai/gpt-5.6-luna openai/gpt-5.6-terra openai/gpt-5.6-sol");
      yield* workflow.answer(root, "openai/gpt-5.6-luna");
      yield* workflow.answer(root, "openai/gpt-5.6-terra");
      yield* workflow.answer(root, "openai/gpt-5.6-terra");
      yield* workflow.answer(root, '{"kind":"highest-quality"}');
      yield* workflow.answer(root, "0.2");
      yield* workflow.answer(root, "{}");
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );
}

test("dimension approval requires complete distinct contrast sidecars", async () => {
  const cases = [
    {
      detail: /contrast sidecar is missing/u,
      mutate: (proposal: Record<string, unknown>) => {
        delete proposal.dimensionContrasts;
      }
    },
    {
      detail: /contrast requests must both be non-empty/u,
      mutate: (proposal: Record<string, unknown>) => {
        const contrasts = proposal.dimensionContrasts as Array<Record<string, unknown>>;
        contrasts[0]!.inScopeRequest = "   ";
      }
    },
    {
      detail: /in-scope and near-miss requests must be distinct/u,
      mutate: (proposal: Record<string, unknown>) => {
        const contrasts = proposal.dimensionContrasts as Array<Record<string, unknown>>;
        contrasts[0]!.nearMissRequest = ` ${String(contrasts[0]!.inScopeRequest).toUpperCase()} `;
      }
    },
    {
      detail: /in-scope request must be exclusive and pairwise distinct/u,
      mutate: (proposal: Record<string, unknown>) => {
        const contrasts = proposal.dimensionContrasts as Array<Record<string, unknown>>;
        contrasts[1]!.inScopeRequest = ` ${String(
          contrasts[0]!.inScopeRequest
        ).toUpperCase()} `;
      }
    }
  ] as const;

  for (const testCase of cases) {
    const root = await makeRepository();
    await completeProjectSetup(root);
    const proposed = await Effect.runPromise(
      Effect.gen(function* () {
        const workflow = yield* EvalProjectWorkflow;
        return yield* workflow.proposeDimensions(root, reviewedProposedDimensions);
      }).pipe(Effect.provide(ProjectWorkflowTestLive))
    );
    const digest = proposed.artifacts?.basisProposalDigest;
    assert.ok(digest !== undefined);
    const proposalPath = path.join(root, ".routekit", "evals", "routing-basis.proposed.json");
    const proposal = JSON.parse(await readFile(proposalPath, "utf8")) as Record<string, unknown>;
    testCase.mutate(proposal);
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const workflow = yield* EvalProjectWorkflow;
        return yield* Effect.exit(workflow.approveDimensions(root, digest));
      }).pipe(Effect.provide(ProjectWorkflowTestLive))
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      assert.ok(error instanceof EvalDimensionContrastError);
      assert.match(error.detail, testCase.detail);
    }
  }
});

test("reviewed artifacts are digest-bound and produce an immutable exact-call plan", async () => {
  const root = await makeRepository();
  await completeProjectSetup(root);

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      const proposedBasis = yield* workflow.proposeDimensions(root, reviewedProposedDimensions);
      assert.equal(proposedBasis.nextAction, "approve-dimensions");
      const basisDigest = proposedBasis.artifacts?.basisProposalDigest;
      assert.ok(basisDigest !== undefined);

      const staleBasisApproval = yield* Effect.exit(
        workflow.approveDimensions(root, "stale-basis-digest")
      );
      assert.equal(staleBasisApproval._tag, "Failure");

      const basisApproved = yield* workflow.approveDimensions(root, basisDigest);
      assert.equal(basisApproved.state.stage, "evaluations-review");
      assert.equal(basisApproved.nextAction, "propose-evaluations");

      const evaluationsProposed = yield* workflow.proposeEvaluations(root, {
        ...reviewedEvaluationInput
      });
      assert.equal(evaluationsProposed.nextAction, "approve-evaluations");
      const evaluationDigest = evaluationsProposed.artifacts?.evaluationProposalDigest;
      assert.ok(evaluationDigest !== undefined);

      const staleEvaluationApproval = yield* Effect.exit(
        workflow.approveEvaluations(root, "stale-evaluation-digest")
      );
      assert.equal(staleEvaluationApproval._tag, "Failure");

      const ready = yield* workflow.approveEvaluations(root, evaluationDigest);
      assert.equal(ready.state.stage, "ready");
      assert.equal(ready.nextAction, "run");
      const plan = yield* workflow.createPlan(root, "pilot");
      return { basisDigest, evaluationDigest, plan };
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );

  const storedBasis = JSON.parse(
    await readFile(path.join(root, ".routekit", "evals", "routing-basis.proposed.json"), "utf8")
  ) as {
    readonly dimensions: ReadonlyArray<Record<string, unknown>>;
    readonly dimensionContrasts: ReadonlyArray<Record<string, unknown>>;
  };
  assert.equal(storedBasis.dimensionContrasts.length, reviewedDimensions.length);
  assert.equal(
    storedBasis.dimensionContrasts.every(
      (contrast) =>
        typeof contrast.inScopeRequest === "string" &&
        typeof contrast.nearMissRequest === "string"
    ),
    true
  );
  assert.equal(
    storedBasis.dimensions.every(
      (dimension) =>
        !Object.hasOwn(dimension, "inScopeRequest") && !Object.hasOwn(dimension, "nearMissRequest")
    ),
    true
  );

  assert.equal(result.plan.basisDigest, result.basisDigest);
  assert.equal(result.plan.evaluationDigest, result.evaluationDigest);
  assert.equal(result.plan.expectedDimensionCandidateCalls, 75);
  assert.equal(result.plan.expectedDimensionJudgeCalls, 75);
  assert.equal(result.plan.expectedClassifierCalls, 5);
  assert.equal(result.plan.expectedCompositionCandidateCalls, 15);
  assert.equal(result.plan.expectedCompositionJudgeCalls, 15);
  assert.equal(result.plan.expectedCandidateCalls, 90);
  assert.equal(result.plan.expectedJudgeCalls, 90);
  assert.equal(result.plan.expectedCallCount, 185);
  assert.equal(result.plan.maximumOutputTokens, 256);

  const planPath = path.join(root, ".routekit", "evals", "plans", `${result.plan.planId}.json`);
  assert.equal((await stat(planPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(planPath, "utf8")), result.plan);
  const firstDimension = reviewedDimensions[0]!;
  const generatedSuite = await readFile(
    path.join(
      root,
      ".routekit",
      "evals",
      "plans",
      result.plan.planId,
      "dimensions",
      firstDimension.id,
      `${firstDimension.id}.eval.ts`
    ),
    "utf8"
  );
  const completionAssertion = generatedSuite.indexOf("run.toComplete();");
  const judgeCall = generatedSuite.indexOf("await judge.autoEvals");
  const completionRethrow = generatedSuite.indexOf("throw candidateCompletionError;");
  assert.ok(completionAssertion >= 0);
  assert.ok(judgeCall > completionAssertion);
  assert.ok(completionRethrow > judgeCall);
  for (const dimension of reviewedDimensions) {
    assert.equal(
      (await stat(path.join(root, ".routekit", "evals", "dimensions", dimension.id, "suite.json")))
        .mode & 0o777,
      0o600
    );
  }
});

test("full qualification refuses fewer than twenty reviewed cases per dimension", async () => {
  const root = await makeRepository();
  await completeProjectSetup(root);
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      const proposed = yield* workflow.proposeDimensions(root, reviewedProposedDimensions);
      yield* workflow.approveDimensions(root, proposed.artifacts!.basisProposalDigest!);
      const evaluations = yield* workflow.proposeEvaluations(root, {
        suites: reviewedSuites.map((suite) => ({ ...suite, cases: suite.cases.slice(0, 5) })),
        decompositionBenchmark: {
          ...reviewedDecompositionBenchmark,
          cases: reviewedDecompositionBenchmark.cases.slice(0, 5)
        },
        compositionSuite: {
          ...reviewedCompositionSuite,
          cases: reviewedCompositionSuite.cases.slice(0, 5)
        }
      });
      yield* workflow.approveEvaluations(root, evaluations.artifacts!.evaluationProposalDigest!);
      return yield* Effect.exit(workflow.createPlan(root, "full"));
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );
  assert.equal(exit._tag, "Failure");
  if (exit._tag === "Failure") {
    assert.match(String(exit.cause), /at least 20 reviewed cases/u);
  }
});

const comparisonResults = (plan: EvalExecutionPlan, runId: string) =>
  reviewedSuites.map((suite) => {
    const selected = plan.selectedCaseIds.find(
      (entry) => entry.dimensionId === suite.dimensionId
    )!;
    const cases = suite.cases.filter((testCase) => selected.caseIds.includes(testCase.id));
    const candidateModels = [
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol"
    ];
    return {
    version: 1 as const,
    comparisonId: `${runId}-${suite.dimensionId}`,
    profileId: suite.dimensionId,
    suiteDigest: `suite-${suite.dimensionId}`,
    judgeModel: "openai/gpt-5.6-terra",
    startedAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:01:00.000Z",
    models: candidateModels.map((model) => ({
      model,
      cases: cases.map((testCase) => ({
        caseId: testCase.id,
        outcome: "passed" as const,
        measurement: {
          judgeScore: 0.9,
          inputTokens: 100,
          outputTokens: 50,
          durationMs: 250
        }
      }))
    })),
    calls: [
      ...candidateModels.flatMap((model) =>
        cases.map((testCase) => ({
          role: "candidate" as const,
          model,
          caseId: testCase.id,
          measurement: { inputTokens: 100, outputTokens: 50 }
        }))
      ),
      ...candidateModels.flatMap(() =>
        cases.map((testCase) => ({
          role: "judge" as const,
          model: "openai/gpt-5.6-terra",
          caseId: testCase.id,
          measurement: { inputTokens: 80, outputTokens: 20 }
        }))
      )
    ]
  };
  });

const compositionComparison = (plan: EvalExecutionPlan, runId: string) => {
  const cases = reviewedCompositionSuite.cases.filter((testCase) =>
    plan.selectedCompositionCaseIds.includes(testCase.id)
  );
  const candidateModels = [...plan.candidateModels];
  return {
    version: 1 as const,
    comparisonId: `${runId}-composition`,
    profileId: "composition",
    suiteDigest: "suite-composition",
    judgeModel: plan.judgeModel,
    startedAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:01:00.000Z",
    models: candidateModels.map((model) => ({
      model,
      cases: cases.map((testCase) => ({
        caseId: testCase.id,
        outcome: "passed" as const,
        measurement: {
          judgeScore: model === candidateModels[0] ? 0.9 : 0.7,
          inputTokens: 100,
          outputTokens: 50,
          durationMs: 250
        }
      }))
    })),
    calls: [
      ...candidateModels.flatMap((model) =>
        cases.map((testCase) => ({
          role: "candidate" as const,
          model,
          caseId: testCase.id,
          measurement: { inputTokens: 100, outputTokens: 50 }
        }))
      ),
      ...candidateModels.flatMap(() =>
        cases.map((testCase) => ({
          role: "judge" as const,
          model: plan.judgeModel,
          caseId: testCase.id,
          measurement: { inputTokens: 80, outputTokens: 20 }
        }))
      )
    ]
  };
};

const qualifiedReport = (
  plan: EvalExecutionPlan,
  runId: string,
  projectId: string,
  publishAllowed = true
): EvalRunReport => {
  const comparisons = [...comparisonResults(plan, runId), compositionComparison(plan, runId)];
  const candidateModels = [...plan.candidateModels];
  const observations = reviewedDecompositionBenchmark.cases
    .filter((testCase) => plan.selectedDecompositionCaseIds.includes(testCase.id))
    .map((testCase) => ({
      caseId: testCase.id,
      weights: testCase.expected.weights,
      unknownWeight: testCase.expected.unknownWeight,
      vectorL1Error: 0,
      passed: true,
      measurement: {
        inputTokens: 40,
        outputTokens: 20
      }
    }));
  return {
    version: 1,
    status: "passed",
    runId,
    planId: plan.planId,
    projectId,
    startedAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:02:00.000Z",
    basisDigest: plan.basisDigest,
    evaluationDigest: plan.evaluationDigest,
    target: {
      kind: publishAllowed ? "configured" : "external",
      identity: "target:test",
      publishAllowed
    },
    cleanup: publishAllowed
      ? { sessionOpened: true, sessionClosed: true }
      : { sessionOpened: false, sessionClosed: false },
    comparisons,
    qualification: {
      decomposition: {
        expectedCases: observations.length,
        passedCases: observations.length,
        maximumObservedL1Error: 0,
        observations
      },
      composition: {
        expectedCases: plan.selectedCompositionCaseIds.length,
        comparableCases: plan.selectedCompositionCaseIds.length,
        agreeingCases: plan.selectedCompositionCaseIds.length,
        winnerAgreement: 1,
        cases: plan.selectedCompositionCaseIds.map((caseId) => ({
          caseId,
          predictedWinner: candidateModels[0]!,
          observedWinner: candidateModels[0]!,
          predictedScoreGap: 0.1,
          observedScoreGap: 0.2,
          passed: true
        }))
      }
    },
    ledger: summarizeEvalRunLedger(comparisons, plan.expectedCallCount, observations),
    activation: {
      version: 2,
      generatedAt: "2026-08-18T00:02:00.000Z",
      basisDigest: plan.basisDigest,
      evidenceDigest: "evidence-digest",
      classifierModel: plan.classifierModel,
      objective: { kind: "highest-quality" },
      maximumUnknownWeight: 0.2,
      dimensions: reviewedDimensions,
      candidateModels,
      evidence: candidateModels.flatMap((model) =>
        reviewedDimensions.map((dimension) => ({
          model,
          dimensionId: dimension.id,
          suiteDigest: `suite-${dimension.id}`,
          evidenceDigest: `${model}-${dimension.id}`,
          quality: {
            passRate: 1,
            lowerConfidenceBound: 0.56,
            sampleCount: plan.scope === "pilot" ? 5 : 20
          },
          failureRate: 0,
          averageJudgeScore: 0.9,
          p95DurationMs: 250,
          unpricedCalls: plan.scope === "pilot" ? 5 : 20
        }))
      )
    }
  };
};

async function createPlan(
  root: string,
  scope: "pilot" | "full" = "pilot"
): Promise<EvalExecutionPlan> {
  await completeProjectSetup(root);
  return Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      const basis = yield* workflow.proposeDimensions(root, reviewedProposedDimensions);
      yield* workflow.approveDimensions(root, basis.artifacts!.basisProposalDigest!);
      const evaluations = yield* workflow.proposeEvaluations(root, reviewedEvaluationInput);
      yield* workflow.approveEvaluations(root, evaluations.artifacts!.evaluationProposalDigest!);
      return yield* workflow.createPlan(root, scope);
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );
}

test("run lifecycle retains complete sanitized evidence and activates only after cleanup", async () => {
  const root = await makeRepository();
  const plan = await createPlan(root, "full");
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      const started = yield* workflow.startRun(root, plan.planId);
      const current = yield* workflow.status(root);
      assert.equal(current?.state.stage, "running");
      const report = qualifiedReport(plan, started.runId, current!.state.projectId);
      const qualified = yield* workflow.finishRun(root, report);
      const loaded = yield* workflow.result(root, started.runId);
      const activated = yield* workflow.markActivated(root, started.runId, "target:test");
      return { started, qualified, loaded, activated };
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );

  assert.equal(outcome.qualified.state.stage, "qualified");
  assert.equal(outcome.loaded?.status, "passed");
  assert.equal(outcome.loaded?.ledger.observedCalls, 740);
  assert.equal(outcome.loaded?.ledger.observedCandidateRows, 360);
  assert.equal(outcome.loaded?.ledger.unpricedCalls, 740);
  assert.equal(outcome.activated.state.stage, "activated");
  const reportPath = path.join(
    root,
    ".routekit",
    "evals",
    "runs",
    outcome.started.runId,
    "report.json"
  );
  assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
});

test("failed runs preserve plan revisions for retry while mismatched plans remain stale", async () => {
  const root = await makeRepository();
  const plan = await createPlan(root, "full");
  const mismatchedPlans: readonly EvalExecutionPlan[] = [
    {
      ...plan,
      planId: `${plan.planId}-project`,
      projectId: "different-project-id"
    },
    {
      ...plan,
      planId: `${plan.planId}-evaluation`,
      evaluationDigest: "different-evaluation-digest"
    },
    {
      ...plan,
      planId: `${plan.planId}-models`,
      candidateModels: [...plan.candidateModels].reverse()
    }
  ];
  await Promise.all(
    mismatchedPlans.map((mismatchedPlan) =>
      writeFile(
        path.join(root, ".routekit", "evals", "plans", `${mismatchedPlan.planId}.json`),
        JSON.stringify(mismatchedPlan)
      )
    )
  );

  const rerun = await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      for (const mismatchedPlan of mismatchedPlans) {
        const mismatch = yield* Effect.exit(workflow.startRun(root, mismatchedPlan.planId));
        assert.equal(mismatch._tag, "Failure");
        if (mismatch._tag === "Failure") {
          assert.match(String(mismatch.cause), /execution plan is stale/u);
        }
      }
      const first = yield* workflow.startRun(root, plan.planId);
      const running = yield* workflow.status(root);
      const ready = yield* workflow.failRun(root, {
        version: 1,
        status: "failed",
        runId: first.runId,
        planId: plan.planId,
        projectId: running!.state.projectId,
        startedAt: "2026-08-21T03:47:27.000Z",
        finishedAt: "2026-08-21T03:47:48.000Z",
        basisDigest: plan.basisDigest,
        evaluationDigest: plan.evaluationDigest,
        target: {
          kind: "configured",
          identity: "routekit-generation:48",
          publishAllowed: true
        },
        cleanup: { sessionOpened: true, sessionClosed: true },
        comparisons: [],
        ledger: {
          expectedCalls: plan.expectedCallCount,
          observedCalls: 0,
          observedCandidateRows: 0,
          knownInputTokens: 0,
          knownOutputTokens: 0,
          unknownTokenMeasurements: 0,
          knownPricedSubtotalUsd: 0,
          unpricedCalls: 0
        },
        failure: "qualification timed out before observing any calls",
        errors: []
      });
      const second = yield* workflow.startRun(root, plan.planId);
      return { ready, second };
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );

  assert.equal(rerun.ready.state.stage, "ready");
  assert.equal(rerun.ready.state.revision, plan.projectRevision);
  assert.equal(rerun.ready.state.basisDigest, plan.basisDigest);
  assert.equal(rerun.ready.state.evaluationDigest, plan.evaluationDigest);
  assert.equal(rerun.second.plan.planId, plan.planId);
});

test("failed run reports persist the nested qualification error chain", async () => {
  const root = await makeRepository();
  const plan = await createPlan(root, "full");
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      const started = yield* workflow.startRun(root, plan.planId);
      const status = yield* workflow.status(root);
      const report: EvalRunReport = {
        version: 1,
        status: "failed",
        runId: started.runId,
        planId: plan.planId,
        projectId: status!.state.projectId,
        startedAt: "2026-08-21T03:47:27.000Z",
        finishedAt: "2026-08-21T03:47:48.000Z",
        basisDigest: plan.basisDigest,
        evaluationDigest: plan.evaluationDigest,
        target: {
          kind: "configured",
          identity: "routekit-generation:48",
          publishAllowed: true
        },
        cleanup: { sessionOpened: true, sessionClosed: true },
        comparisons: [],
        ledger: {
          expectedCalls: plan.expectedCallCount,
          observedCalls: 0,
          observedCandidateRows: 0,
          knownInputTokens: 0,
          knownOutputTokens: 0,
          unknownTokenMeasurements: 0,
          knownPricedSubtotalUsd: 0,
          unpricedCalls: 0
        },
        failure:
          'qualification dimension "provider-protocol-translation" failed ' +
          "(per-test timeout 600000ms); observed call ids: none",
        errors: [
          {
            name: "EvalServiceComparisonError",
            message: "RouteKit Eval comparison failed",
            stack: "EvalServiceComparisonError: RouteKit Eval comparison failed"
          },
          {
            name: "RouteKitEvalGatewayBridgeStartError",
            message: "Could not start the scoped RouteKit Eval gateway bridge.",
            stack:
              "RouteKitEvalGatewayBridgeStartError: Could not start the scoped RouteKit Eval gateway bridge."
          }
        ]
      };
      yield* workflow.failRun(root, report);
      return {
        loaded: yield* workflow.result(root, started.runId),
        runId: started.runId
      };
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );

  assert.equal(outcome.loaded?.status, "failed");
  assert.deepEqual(outcome.loaded?.status === "failed" ? outcome.loaded.errors : undefined, [
    {
      name: "EvalServiceComparisonError",
      message: "RouteKit Eval comparison failed",
      stack: "EvalServiceComparisonError: RouteKit Eval comparison failed"
    },
    {
      name: "RouteKitEvalGatewayBridgeStartError",
      message: "Could not start the scoped RouteKit Eval gateway bridge.",
      stack:
        "RouteKitEvalGatewayBridgeStartError: Could not start the scoped RouteKit Eval gateway bridge."
    }
  ]);
  const raw = JSON.parse(
    await readFile(
      path.join(root, ".routekit", "evals", "runs", outcome.runId, "report.json"),
      "utf8"
    )
  ) as { readonly errors?: readonly unknown[] };
  assert.equal(raw.errors?.length, 2);
});

test("incomplete evidence and external qualification fail closed", async () => {
  const incompleteRoot = await makeRepository();
  const incompletePlan = await createPlan(incompleteRoot, "full");
  await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      const started = yield* workflow.startRun(incompleteRoot, incompletePlan.planId);
      const status = yield* workflow.status(incompleteRoot);
      const report = qualifiedReport(incompletePlan, started.runId, status!.state.projectId);
      assert.equal(report.status, "passed");
      if (report.status !== "passed") return;
      const [first, ...rest] = report.comparisons;
      assert.ok(first !== undefined);
      const incomplete: EvalRunReport = {
        ...report,
        comparisons: [
          {
            ...first,
            models: first.models.map((model, index) =>
              index === 0 ? { ...model, cases: model.cases.slice(0, -1) } : model
            )
          },
          ...rest
        ]
      };
      const exit = yield* Effect.exit(workflow.finishRun(incompleteRoot, incomplete));
      assert.equal(exit._tag, "Failure");
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );

  const externalRoot = await makeRepository();
  const externalPlan = await createPlan(externalRoot, "full");
  await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* EvalProjectWorkflow;
      const started = yield* workflow.startRun(externalRoot, externalPlan.planId);
      const status = yield* workflow.status(externalRoot);
      const report = qualifiedReport(externalPlan, started.runId, status!.state.projectId, false);
      yield* workflow.finishRun(externalRoot, report);
      const exit = yield* Effect.exit(
        workflow.markActivated(externalRoot, started.runId, "target:test")
      );
      assert.equal(exit._tag, "Failure");
    }).pipe(Effect.provide(ProjectWorkflowTestLive))
  );
});
