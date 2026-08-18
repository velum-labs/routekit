import type { RoutingBasis } from "@velum-labs/routekit-eval-contracts";
import {
  assertDecompositionResult,
  assertPublishedRoutingActivation,
  assertRoutingObjectivePolicy,
  isForbiddenEvalModel
} from "@velum-labs/routekit-eval-contracts";
import {
  RoutingActivationConstraints,
  RoutingObjectivePolicy
} from "@velum-labs/routekit-eval-contracts";
import { Clock, Context, Effect, Layer, Path, Schema } from "effect";

import type { EvalProjectArtifactError, EvalSetupInspectionError } from "./errors.js";
import { type EvalProjectStoreError, EvalProjectTransitionError } from "./errors.js";
import { EvalRepositoryInspector } from "./inspection.js";
import {
  EvalProjectArtifacts,
  evaluationProposalDigest,
  routingBasisDigest
} from "./project-artifacts.js";
import type {
  EvalEvaluationProposal,
  EvalExecutionPlan,
  EvalPlanScope,
  EvalProjectConfiguration,
  EvalProjectQuestion,
  EvalProjectSetupProgress,
  EvalProjectState,
  EvalProjectStatus,
  EvalRunReport
} from "./project-contracts.js";
import { EVAL_PROJECT_VERSION, summarizeEvalRunLedger } from "./project-contracts.js";
import { EvalProjectStore } from "./project-store.js";

const isoNow = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

const questionForProgress = (progress: EvalProjectSetupProgress): EvalProjectQuestion => {
  switch (progress._tag) {
    case "WorkloadDescriptionRequired":
      return {
        id: "workload-description",
        prompt: "What production workload should RouteKit learn to route?",
        options: []
      };
    case "CandidateModelsRequired":
      return {
        id: "candidate-models",
        prompt: "Which explicit provider/model IDs may RouteKit route to?",
        options: []
      };
    case "ClassifierModelRequired":
      return {
        id: "classifier-model",
        prompt: "Which explicit provider/model ID should decompose requests?",
        options: []
      };
    case "AuthorModelRequired":
      return {
        id: "author-model",
        prompt: "Which explicit provider/model ID should propose dimensions and evaluations?",
        options: []
      };
    case "JudgeModelRequired":
      return {
        id: "judge-model",
        prompt: "Which explicit provider/model ID should judge evaluation results?",
        options: []
      };
    case "RoutingObjectiveRequired":
      return {
        id: "routing-objective",
        prompt:
          "Provide the complete deterministic routing objective as JSON. Quality thresholds and metric weights are required when the selected objective uses them.",
        options: [
          '{"kind":"highest-quality"}',
          '{"kind":"lowest-cost","minimumQuality":0.8}',
          '{"kind":"lowest-latency","minimumQuality":0.8}',
          '{"kind":"balanced","minimumQuality":0.8,"weights":{"quality":0.6,"cost":0.2,"latency":0.2}}',
          '{"kind":"pareto","minimumQuality":0.8,"preference":"quality"}'
        ]
      };
    case "MaximumUnknownWeightRequired":
      return {
        id: "maximum-unknown-weight",
        prompt:
          "What maximum uncovered request weight may be routed automatically? Provide a number from 0 to 1.",
        options: ["0.1", "0.2", "0.3"]
      };
    case "RoutingConstraintsRequired":
      return {
        id: "routing-constraints",
        prompt:
          'Provide routing activation constraints as JSON, or "{}" for no additional quality/failure constraints.',
        options: [
          "{}",
          '{"maximumFailureRate":0.05}',
          '{"minimumDimensionQuality":{"example-dimension":0.8},"maximumFailureRate":0.05}'
        ]
      };
    default:
      throw new Error("unsupported eval project setup question");
  }
};

const nextAction = (
  state: EvalProjectState,
  artifacts: NonNullable<EvalProjectStatus["artifacts"]>
): EvalProjectStatus["nextAction"] => {
  switch (state.stage) {
    case "setup-required":
      return "answer";
    case "dimensions-review":
      return artifacts.basisProposalDigest === undefined
        ? "propose-dimensions"
        : "approve-dimensions";
    case "evaluations-review":
      return artifacts.evaluationProposalDigest === undefined
        ? "propose-evaluations"
        : "approve-evaluations";
    case "ready":
      return "run";
    case "running":
      return "none";
    case "qualified":
      return "publish";
    case "activated":
      return "none";
    default:
      return "none";
  }
};

const transitionError = (state: string, detail: string): EvalProjectTransitionError =>
  new EvalProjectTransitionError({ state, detail });

const nonEmptyAnswer = (
  state: EvalProjectState,
  answer: string
): Effect.Effect<string, EvalProjectTransitionError> => {
  const value = answer.trim();
  return value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(transitionError(state.stage, "answer must not be empty"));
};

const validateModel = (
  state: EvalProjectState,
  model: string,
  role: string
): Effect.Effect<string, EvalProjectTransitionError> =>
  isForbiddenEvalModel(model)
    ? Effect.fail(
        transitionError(
          state.stage,
          `${role} model must be an explicit provider/model id, not ${JSON.stringify(model)}`
        )
      )
    : Effect.succeed(model);

const parseCandidateModels = (
  state: EvalProjectState,
  answer: string
): Effect.Effect<readonly string[], EvalProjectTransitionError> =>
  Effect.gen(function* () {
    const value = yield* nonEmptyAnswer(state, answer);
    const candidates = value
      .split(/[\s,]+/u)
      .map((model) => model.trim())
      .filter((model) => model.length > 0);
    const unique = [...new Set(candidates)];
    if (unique.length < 2 || unique.length > 32 || unique.length !== candidates.length) {
      return yield* transitionError(
        state.stage,
        "candidate models must contain between 2 and 32 unique explicit provider/model IDs"
      );
    }
    for (const candidate of unique) {
      yield* validateModel(state, candidate, "candidate");
    }
    return unique;
  });

const parseModel = (
  state: EvalProjectState,
  answer: string,
  role: "classifier" | "author" | "judge"
): Effect.Effect<string, EvalProjectTransitionError> =>
  Effect.gen(function* () {
    const model = yield* nonEmptyAnswer(state, answer);
    return yield* validateModel(state, model, role);
  });

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameLedger = (left: EvalRunReport["ledger"], right: EvalRunReport["ledger"]): boolean =>
  left.expectedCalls === right.expectedCalls &&
  left.observedCalls === right.observedCalls &&
  left.observedCandidateRows === right.observedCandidateRows &&
  left.knownInputTokens === right.knownInputTokens &&
  left.knownOutputTokens === right.knownOutputTokens &&
  left.unknownTokenMeasurements === right.unknownTokenMeasurements &&
  left.knownPricedSubtotalUsd === right.knownPricedSubtotalUsd &&
  left.unpricedCalls === right.unpricedCalls;

const validateQualifiedReport = (
  state: Extract<EvalProjectState, { readonly stage: "running" }>,
  plan: EvalExecutionPlan,
  proposal: EvalEvaluationProposal,
  report: Extract<EvalRunReport, { readonly status: "passed" | "completed" }>
): void => {
  assertPublishedRoutingActivation(report.activation);
  if (
    report.activation.basisDigest !== state.basisDigest ||
    report.activation.classifierModel !== state.configuration.classifierModel ||
    !sameStrings(report.activation.candidateModels, plan.candidateModels)
  ) {
    throw new Error("published activation does not match the immutable execution plan");
  }
  const expectedDimensions = new Map(
    plan.selectedCaseIds.map((entry) => [entry.dimensionId, new Set(entry.caseIds)] as const)
  );
  const comparisons = new Map<string, (typeof report.comparisons)[number]>();
  const validateComparison = (
    comparison: (typeof report.comparisons)[number],
    expectedCases: ReadonlySet<string>
  ): void => {
    if (
      comparison.judgeModel !== plan.judgeModel ||
      comparison.suiteDigest.trim().length === 0
    ) {
      throw new Error("comparison result does not match the planned judge or suite");
    }
    const seenModels = new Set<string>();
    for (const model of comparison.models) {
      if (!plan.candidateModels.includes(model.model) || seenModels.has(model.model)) {
        throw new Error("comparison results contain an unexpected or duplicate candidate");
      }
      seenModels.add(model.model);
      if (model.cases.length !== expectedCases.size) {
        throw new Error("comparison candidate case count does not match the execution plan");
      }
      const seenCases = new Set<string>();
      for (const testCase of model.cases) {
        if (
          !expectedCases.has(testCase.caseId) ||
          seenCases.has(testCase.caseId) ||
          testCase.outcome === "unknown" ||
          testCase.outcome === "cutoff" ||
          testCase.measurement.judgeScore === undefined
        ) {
          throw new Error("comparison evidence is incomplete, duplicated, or non-terminal");
        }
        seenCases.add(testCase.caseId);
      }
    }
    if (
      seenModels.size !== plan.candidateModels.length ||
      plan.candidateModels.some((model) => !seenModels.has(model))
    ) {
      throw new Error("comparison is missing a configured candidate model");
    }
    if (comparison.calls === undefined) {
      throw new Error("comparison is missing sanitized per-call accounting");
    }
    const expectedCallRows = expectedCases.size * plan.candidateModels.length;
    const candidateCalls = comparison.calls.filter((call) => call.role === "candidate");
    const judgeCalls = comparison.calls.filter((call) => call.role === "judge");
    if (
      candidateCalls.length !== expectedCallRows ||
      judgeCalls.length !== expectedCallRows ||
      comparison.calls.length !== expectedCallRows * 2
    ) {
      throw new Error("comparison call accounting does not match the manifest");
    }
    for (const call of comparison.calls) {
      if (
        !expectedCases.has(call.caseId) ||
        (call.role === "candidate"
          ? !plan.candidateModels.includes(call.model)
          : call.model !== plan.judgeModel)
      ) {
        throw new Error("comparison call accounting contains an unexpected case or model");
      }
    }
  };
  for (const comparison of report.comparisons) {
    if (comparison.profileId === "composition") continue;
    const expectedCases = expectedDimensions.get(comparison.profileId);
    if (expectedCases === undefined || comparisons.has(comparison.profileId)) {
      throw new Error("comparison results do not cover the planned dimensions exactly once");
    }
    validateComparison(comparison, expectedCases);
    comparisons.set(comparison.profileId, comparison);
  }
  if (
    comparisons.size !== expectedDimensions.size ||
    [...expectedDimensions.keys()].some((dimensionId) => !comparisons.has(dimensionId))
  ) {
    throw new Error("comparison results are missing a planned dimension");
  }
  const compositionComparisons = report.comparisons.filter(
    (comparison) => comparison.profileId === "composition"
  );
  if (compositionComparisons.length !== 1 || compositionComparisons[0] === undefined) {
    throw new Error("qualification requires exactly one composition comparison");
  }
  validateComparison(
    compositionComparisons[0],
    new Set(plan.selectedCompositionCaseIds)
  );

  const qualification = report.qualification;
  if (qualification === undefined) {
    throw new Error("qualification report is missing decomposition and composition results");
  }
  const expectedDecompositionCases = new Set(plan.selectedDecompositionCaseIds);
  const observedDecompositionCases = new Set<string>();
  for (const observation of qualification.decomposition.observations) {
    if (
      !expectedDecompositionCases.has(observation.caseId) ||
      observedDecompositionCases.has(observation.caseId) ||
      !observation.passed ||
      observation.vectorL1Error > proposal.decompositionBenchmark.maximumVectorL1Error
    ) {
      throw new Error("decomposition qualification is incomplete, duplicated, or failed");
    }
    observedDecompositionCases.add(observation.caseId);
  }
  if (
    qualification.decomposition.expectedCases !== expectedDecompositionCases.size ||
    qualification.decomposition.passedCases !== expectedDecompositionCases.size ||
    observedDecompositionCases.size !== expectedDecompositionCases.size ||
    qualification.decomposition.maximumObservedL1Error >
      proposal.decompositionBenchmark.maximumVectorL1Error
  ) {
    throw new Error("decomposition qualification summary does not match the execution plan");
  }
  const expectedCompositionCases = new Set(plan.selectedCompositionCaseIds);
  const observedCompositionCases = new Set<string>();
  for (const result of qualification.composition.cases) {
    if (
      !expectedCompositionCases.has(result.caseId) ||
      observedCompositionCases.has(result.caseId)
    ) {
      throw new Error("composition qualification contains an unknown or duplicate case");
    }
    observedCompositionCases.add(result.caseId);
  }
  if (
    qualification.composition.expectedCases !== expectedCompositionCases.size ||
    observedCompositionCases.size !== expectedCompositionCases.size ||
    qualification.composition.comparableCases < 1 ||
    qualification.composition.agreeingCases !==
      qualification.composition.cases.filter((result) => result.passed).length ||
    Math.abs(
      qualification.composition.winnerAgreement -
        qualification.composition.agreeingCases / qualification.composition.comparableCases
    ) > 1e-6 ||
    qualification.composition.winnerAgreement <
      proposal.compositionSuite.minimumWinnerAgreement
  ) {
    throw new Error("composition qualification summary does not meet the reviewed threshold");
  }
  const ledger = summarizeEvalRunLedger(
    report.comparisons,
    plan.expectedCallCount,
    qualification.decomposition.observations
  );
  if (
    ledger.observedCalls !== plan.expectedCallCount ||
    ledger.observedCandidateRows !== plan.expectedCandidateCalls ||
    !sameLedger(ledger, report.ledger)
  ) {
    throw new Error("qualification ledger does not match the completed evidence");
  }
};

const parseObjective = (
  state: EvalProjectState,
  answer: string
): Effect.Effect<RoutingObjectivePolicy, EvalProjectTransitionError> =>
  Effect.gen(function* () {
    const text = yield* nonEmptyAnswer(state, answer);
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () =>
        transitionError(
          state.stage,
          "routing objective must be a complete JSON object matching one of the shown examples"
        )
    });
    const objective = yield* Schema.decodeUnknownEffect(RoutingObjectivePolicy)(json).pipe(
      Effect.mapError(() =>
        transitionError(
          state.stage,
          "routing objective is incomplete or has invalid quality, weight, or preference values"
        )
      )
    );
    yield* Effect.try({
      try: () => assertRoutingObjectivePolicy(objective),
      catch: () =>
        transitionError(
          state.stage,
          "routing objective is invalid; balanced weights must sum exactly to one"
        )
    });
    return objective;
  });

const configurationFrom = (
  progress: Extract<EvalProjectSetupProgress, { readonly _tag: "RoutingConstraintsRequired" }>,
  constraints: RoutingActivationConstraints | undefined
): EvalProjectConfiguration => ({
  workloadDescription: progress.workloadDescription,
  candidateModels: progress.candidateModels,
  classifierModel: progress.classifierModel,
  authorModel: progress.authorModel,
  judgeModel: progress.judgeModel,
  objective: progress.objective,
  maximumUnknownWeight: progress.maximumUnknownWeight,
  ...(constraints === undefined ? {} : { constraints })
});

const parseMaximumUnknownWeight = (
  state: EvalProjectState,
  answer: string
): Effect.Effect<number, EvalProjectTransitionError> =>
  Effect.gen(function* () {
    const text = yield* nonEmptyAnswer(state, answer);
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return yield* transitionError(
        state.stage,
        "maximum unknown weight must be a finite number from 0 to 1"
      );
    }
    return value;
  });

const parseConstraints = (
  state: EvalProjectState,
  answer: string
): Effect.Effect<RoutingActivationConstraints | undefined, EvalProjectTransitionError> =>
  Effect.gen(function* () {
    const text = yield* nonEmptyAnswer(state, answer);
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () =>
        transitionError(state.stage, "routing constraints must be a JSON object")
    });
    const constraints = yield* Schema.decodeUnknownEffect(RoutingActivationConstraints)(json).pipe(
      Effect.mapError(() =>
        transitionError(
          state.stage,
          "routing constraints contain invalid dimension quality or failure-rate values"
        )
      )
    );
    return Object.keys(constraints).length === 0 ? undefined : constraints;
  });

const advanceSetup = (
  state: Extract<EvalProjectState, { readonly stage: "setup-required" }>,
  answer: string,
  now: string
): Effect.Effect<EvalProjectState, EvalProjectTransitionError> =>
  Effect.gen(function* () {
    const common = {
      version: state.version,
      projectId: state.projectId,
      revision: state.revision + 1,
      createdAt: state.createdAt,
      updatedAt: now,
      sourceInventory: state.sourceInventory
    } as const;
    switch (state.progress._tag) {
      case "WorkloadDescriptionRequired":
        return {
          ...common,
          stage: "setup-required",
          progress: {
            _tag: "CandidateModelsRequired",
            workloadDescription: yield* nonEmptyAnswer(state, answer)
          }
        };
      case "CandidateModelsRequired":
        return {
          ...common,
          stage: "setup-required",
          progress: {
            _tag: "ClassifierModelRequired",
            workloadDescription: state.progress.workloadDescription,
            candidateModels: yield* parseCandidateModels(state, answer)
          }
        };
      case "ClassifierModelRequired":
        return {
          ...common,
          stage: "setup-required",
          progress: {
            _tag: "AuthorModelRequired",
            workloadDescription: state.progress.workloadDescription,
            candidateModels: state.progress.candidateModels,
            classifierModel: yield* parseModel(state, answer, "classifier")
          }
        };
      case "AuthorModelRequired":
        return {
          ...common,
          stage: "setup-required",
          progress: {
            _tag: "JudgeModelRequired",
            workloadDescription: state.progress.workloadDescription,
            candidateModels: state.progress.candidateModels,
            classifierModel: state.progress.classifierModel,
            authorModel: yield* parseModel(state, answer, "author")
          }
        };
      case "JudgeModelRequired":
        return {
          ...common,
          stage: "setup-required",
          progress: {
            _tag: "RoutingObjectiveRequired",
            workloadDescription: state.progress.workloadDescription,
            candidateModels: state.progress.candidateModels,
            classifierModel: state.progress.classifierModel,
            authorModel: state.progress.authorModel,
            judgeModel: yield* parseModel(state, answer, "judge")
          }
        };
      case "RoutingObjectiveRequired": {
        const objective = yield* parseObjective(state, answer);
        return {
          ...common,
          stage: "setup-required",
          progress: {
            _tag: "MaximumUnknownWeightRequired",
            workloadDescription: state.progress.workloadDescription,
            candidateModels: state.progress.candidateModels,
            classifierModel: state.progress.classifierModel,
            authorModel: state.progress.authorModel,
            judgeModel: state.progress.judgeModel,
            objective
          }
        };
      }
      case "MaximumUnknownWeightRequired":
        return {
          ...common,
          stage: "setup-required",
          progress: {
            _tag: "RoutingConstraintsRequired",
            workloadDescription: state.progress.workloadDescription,
            candidateModels: state.progress.candidateModels,
            classifierModel: state.progress.classifierModel,
            authorModel: state.progress.authorModel,
            judgeModel: state.progress.judgeModel,
            objective: state.progress.objective,
            maximumUnknownWeight: yield* parseMaximumUnknownWeight(state, answer)
          }
        };
      case "RoutingConstraintsRequired": {
        const constraints = yield* parseConstraints(state, answer);
        return {
          ...common,
          stage: "dimensions-review",
          configuration: configurationFrom(state.progress, constraints)
        };
      }
      default:
        return yield* transitionError(state.stage, "unsupported setup progress state");
    }
  });

export type EvalProjectWorkflowError =
  | EvalProjectStoreError
  | EvalProjectArtifactError
  | EvalSetupInspectionError
  | EvalProjectTransitionError;

export type EvalProjectWorkflowShape = {
  readonly setup: (
    repositoryRoot: string
  ) => Effect.Effect<EvalProjectStatus, EvalProjectWorkflowError>;
  readonly status: (
    repositoryRoot: string
  ) => Effect.Effect<
    EvalProjectStatus | undefined,
    EvalProjectStoreError | EvalProjectArtifactError
  >;
  readonly answer: (
    repositoryRoot: string,
    answer: string
  ) => Effect.Effect<
    EvalProjectStatus,
    EvalProjectStoreError | EvalProjectArtifactError | EvalProjectTransitionError
  >;
  readonly proposeDimensions: (
    repositoryRoot: string,
    dimensions: RoutingBasis["dimensions"]
  ) => Effect.Effect<EvalProjectStatus, EvalProjectWorkflowError>;
  readonly approveDimensions: (
    repositoryRoot: string,
    basisDigest: string
  ) => Effect.Effect<EvalProjectStatus, EvalProjectWorkflowError>;
  readonly proposeEvaluations: (
    repositoryRoot: string,
    proposal: Omit<
      EvalEvaluationProposal,
      "version" | "evaluationDigest" | "basisDigest" | "candidateModels" | "judgeModel"
    >
  ) => Effect.Effect<EvalProjectStatus, EvalProjectWorkflowError>;
  readonly approveEvaluations: (
    repositoryRoot: string,
    evaluationDigest: string
  ) => Effect.Effect<EvalProjectStatus, EvalProjectWorkflowError>;
  readonly createPlan: (
    repositoryRoot: string,
    scope: EvalPlanScope
  ) => Effect.Effect<EvalExecutionPlan, EvalProjectWorkflowError>;
  readonly startRun: (
    repositoryRoot: string,
    planId: string
  ) => Effect.Effect<
    { readonly plan: EvalExecutionPlan; readonly runId: string },
    EvalProjectWorkflowError
  >;
  readonly finishRun: (
    repositoryRoot: string,
    report: EvalRunReport
  ) => Effect.Effect<EvalProjectStatus, EvalProjectWorkflowError>;
  readonly failRun: (
    repositoryRoot: string,
    report: EvalRunReport
  ) => Effect.Effect<EvalProjectStatus, EvalProjectWorkflowError>;
  readonly result: (
    repositoryRoot: string,
    runId?: string
  ) => Effect.Effect<EvalRunReport | undefined, EvalProjectWorkflowError>;
  readonly markActivated: (
    repositoryRoot: string,
    runId: string,
    targetIdentity: string
  ) => Effect.Effect<EvalProjectStatus, EvalProjectWorkflowError>;
};

export class EvalProjectWorkflow extends Context.Service<
  EvalProjectWorkflow,
  EvalProjectWorkflowShape
>()("@velum-labs/routekit-eval-setup/EvalProjectWorkflow") {}

export const makeEvalProjectWorkflow = Effect.gen(function* () {
  const store = yield* EvalProjectStore;
  const artifacts = yield* EvalProjectArtifacts;
  const inspector = yield* EvalRepositoryInspector;
  const paths = yield* Path.Path;

  const resolveRoot = (repositoryRoot: string): string => paths.resolve(repositoryRoot);

  const statusOf = (
    root: string,
    state: EvalProjectState
  ): Effect.Effect<EvalProjectStatus, EvalProjectArtifactError> =>
    Effect.gen(function* () {
      const [basis, basisApproval, evaluations, evaluationsApproval, plans] = yield* Effect.all([
        artifacts.loadBasisProposal(root),
        artifacts.loadBasisApproval(root),
        artifacts.loadEvaluationProposal(root),
        artifacts.loadEvaluationsApproval(root),
        artifacts.listPlans(root)
      ]);
      const artifactStatus: NonNullable<EvalProjectStatus["artifacts"]> = {
        ...(basis === undefined ? {} : { basisProposalDigest: basis.basisDigest }),
        basisApproved:
          basis !== undefined &&
          basisApproval?.kind === "routing-basis" &&
          basisApproval.digest === basis.basisDigest,
        ...(evaluations === undefined
          ? {}
          : { evaluationProposalDigest: evaluations.evaluationDigest }),
        evaluationsApproved:
          evaluations !== undefined &&
          evaluationsApproval?.kind === "evaluations" &&
          evaluationsApproval.digest === evaluations.evaluationDigest,
        plans
      };
      return {
        state,
        ...(state.stage === "setup-required"
          ? { question: questionForProgress(state.progress) }
          : {}),
        artifacts: artifactStatus,
        nextAction: nextAction(state, artifactStatus)
      };
    });

  const loadRequired = (
    root: string
  ): Effect.Effect<EvalProjectState, EvalProjectStoreError | EvalProjectTransitionError> =>
    store
      .load(root)
      .pipe(
        Effect.flatMap((state) =>
          state === undefined
            ? Effect.fail(transitionError("absent", "no eval project exists; run eval setup first"))
            : Effect.succeed(state)
        )
      );

  const setup: EvalProjectWorkflowShape["setup"] = (repositoryRoot) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      const existing = yield* store.load(root);
      if (existing !== undefined) return yield* statusOf(root, existing);
      const inspection = yield* inspector.inspect(root);
      const now = yield* isoNow;
      const state: EvalProjectState = {
        version: EVAL_PROJECT_VERSION,
        projectId: crypto.randomUUID(),
        revision: 0,
        createdAt: now,
        updatedAt: now,
        sourceInventory: [
          ...new Set([
            ...inspection.surfaces.map(({ path }) => path),
            ...inspection.materials.map(({ path }) => path)
          ])
        ].sort((left, right) => left.localeCompare(right)),
        stage: "setup-required",
        progress: { _tag: "WorkloadDescriptionRequired" }
      };
      yield* store.save(root, state);
      return yield* statusOf(root, state);
    });

  const status: EvalProjectWorkflowShape["status"] = (repositoryRoot) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      const state = yield* store.load(root);
      return state === undefined ? undefined : yield* statusOf(root, state);
    });

  const answer: EvalProjectWorkflowShape["answer"] = (repositoryRoot, answerText) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      const state = yield* store.load(root);
      if (state === undefined) {
        return yield* transitionError("absent", "no eval project exists; run eval setup first");
      }
      if (state.stage !== "setup-required") {
        return yield* transitionError(state.stage, "project setup has no unanswered question");
      }
      const next = yield* advanceSetup(state, answerText, yield* isoNow);
      yield* store.save(root, next);
      return yield* statusOf(root, next);
    });

  const proposeDimensions: EvalProjectWorkflowShape["proposeDimensions"] = (
    repositoryRoot,
    dimensions
  ) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      const state = yield* loadRequired(root);
      if (state.stage !== "dimensions-review") {
        return yield* transitionError(
          state.stage,
          "routing dimensions can only be proposed after setup"
        );
      }
      const basis: RoutingBasis = {
        version: 2,
        basisDigest: routingBasisDigest(dimensions),
        dimensions
      };
      yield* artifacts.saveBasisProposal(root, basis);
      return yield* statusOf(root, state);
    });

  const approveDimensions: EvalProjectWorkflowShape["approveDimensions"] = (
    repositoryRoot,
    expectedDigest
  ) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      const state = yield* loadRequired(root);
      if (state.stage !== "dimensions-review") {
        return yield* transitionError(state.stage, "routing dimensions are not awaiting approval");
      }
      const basis = yield* artifacts.loadBasisProposal(root);
      if (basis === undefined) {
        return yield* transitionError(state.stage, "no routing basis proposal exists");
      }
      if (basis.basisDigest !== expectedDigest) {
        return yield* transitionError(
          state.stage,
          "routing basis changed after review; approve its current digest"
        );
      }
      const now = yield* isoNow;
      yield* artifacts.saveBasisApproval(root, {
        version: EVAL_PROJECT_VERSION,
        kind: "routing-basis",
        digest: basis.basisDigest,
        approvedAt: now
      });
      const next: EvalProjectState = {
        version: state.version,
        projectId: state.projectId,
        revision: state.revision + 1,
        createdAt: state.createdAt,
        updatedAt: now,
        sourceInventory: state.sourceInventory,
        stage: "evaluations-review",
        configuration: state.configuration,
        basisDigest: basis.basisDigest
      };
      yield* store.save(root, next);
      return yield* statusOf(root, next);
    });

  const proposeEvaluations: EvalProjectWorkflowShape["proposeEvaluations"] = (
    repositoryRoot,
    input
  ) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      const state = yield* loadRequired(root);
      if (state.stage !== "evaluations-review") {
        return yield* transitionError(
          state.stage,
          "dimension evaluations can only be proposed after routing-basis approval"
        );
      }
      const basis = yield* artifacts.loadBasisProposal(root);
      const approval = yield* artifacts.loadBasisApproval(root);
      if (
        basis === undefined ||
        approval?.kind !== "routing-basis" ||
        approval.digest !== state.basisDigest ||
        basis.basisDigest !== state.basisDigest
      ) {
        return yield* transitionError(state.stage, "approved routing basis is missing or stale");
      }
      const expectedDimensions = new Set(basis.dimensions.map((dimension) => dimension.id));
      const actualDimensions = new Set(input.suites.map((suite) => suite.dimensionId));
      if (
        actualDimensions.size !== input.suites.length ||
        actualDimensions.size !== expectedDimensions.size ||
        [...expectedDimensions].some((dimensionId) => !actualDimensions.has(dimensionId))
      ) {
        return yield* transitionError(
          state.stage,
          "evaluation proposal must contain exactly one suite for every workload dimension"
        );
      }
      for (const benchmarkCase of input.decompositionBenchmark.cases) {
        yield* Effect.try({
          try: () => assertDecompositionResult(benchmarkCase.expected, basis),
          catch: () =>
            transitionError(
              state.stage,
              `decomposition benchmark case ${JSON.stringify(
                benchmarkCase.id
              )} does not cover the approved basis`
            )
        });
      }
      for (const compositionCase of input.compositionSuite.cases) {
        yield* Effect.try({
          try: () => {
            assertDecompositionResult(compositionCase.decomposition, basis);
            if (
              compositionCase.decomposition.weights.filter((entry) => entry.weight > 1e-6)
                .length < 2
            ) {
              throw new Error("composition case must activate at least two dimensions");
            }
          },
          catch: () =>
            transitionError(
              state.stage,
              `composition benchmark case ${JSON.stringify(
                compositionCase.id
              )} has an invalid multi-dimension vector`
            )
        });
      }
      const withoutDigest = {
        version: EVAL_PROJECT_VERSION,
        basisDigest: state.basisDigest,
        candidateModels: state.configuration.candidateModels,
        judgeModel: state.configuration.judgeModel,
        suites: input.suites,
        decompositionBenchmark: input.decompositionBenchmark,
        compositionSuite: input.compositionSuite
      } as const;
      const proposal: EvalEvaluationProposal = {
        ...withoutDigest,
        evaluationDigest: evaluationProposalDigest(withoutDigest)
      };
      yield* artifacts.saveEvaluationProposal(root, proposal);
      return yield* statusOf(root, state);
    });

  const approveEvaluations: EvalProjectWorkflowShape["approveEvaluations"] = (
    repositoryRoot,
    expectedDigest
  ) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      const state = yield* loadRequired(root);
      if (state.stage !== "evaluations-review") {
        return yield* transitionError(
          state.stage,
          "dimension evaluations are not awaiting approval"
        );
      }
      const proposal = yield* artifacts.loadEvaluationProposal(root);
      if (proposal === undefined) {
        return yield* transitionError(state.stage, "no evaluation proposal exists");
      }
      if (
        proposal.evaluationDigest !== expectedDigest ||
        proposal.basisDigest !== state.basisDigest
      ) {
        return yield* transitionError(
          state.stage,
          "evaluation proposal changed after review; approve its current digest"
        );
      }
      const now = yield* isoNow;
      yield* artifacts.saveEvaluationsApproval(root, {
        version: EVAL_PROJECT_VERSION,
        kind: "evaluations",
        digest: proposal.evaluationDigest,
        approvedAt: now
      });
      const next: EvalProjectState = {
        version: state.version,
        projectId: state.projectId,
        revision: state.revision + 1,
        createdAt: state.createdAt,
        updatedAt: now,
        sourceInventory: state.sourceInventory,
        stage: "ready",
        configuration: state.configuration,
        basisDigest: state.basisDigest,
        evaluationDigest: proposal.evaluationDigest
      };
      yield* store.save(root, next);
      return yield* statusOf(root, next);
    });

  const createPlan: EvalProjectWorkflowShape["createPlan"] = (repositoryRoot, scope) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      const state = yield* loadRequired(root);
      if (state.stage !== "ready" && state.stage !== "qualified") {
        return yield* transitionError(
          state.stage,
          "an immutable execution plan requires approved evaluations"
        );
      }
      const proposal = yield* artifacts.loadEvaluationProposal(root);
      const approval = yield* artifacts.loadEvaluationsApproval(root);
      if (
        proposal === undefined ||
        approval?.kind !== "evaluations" ||
        approval.digest !== proposal.evaluationDigest ||
        proposal.evaluationDigest !== state.evaluationDigest ||
        proposal.basisDigest !== state.basisDigest
      ) {
        return yield* transitionError(state.stage, "approved evaluation artifacts are stale");
      }
      if (scope === "full") {
        const shortSuite = proposal.suites.find((suite) => suite.cases.length < 20);
        if (
          shortSuite !== undefined ||
          proposal.decompositionBenchmark.cases.length < 20 ||
          proposal.compositionSuite.cases.length < 20
        ) {
          return yield* transitionError(
            state.stage,
            shortSuite === undefined
              ? "full qualification requires at least 20 reviewed decomposition and composition cases"
              : `full qualification requires at least 20 reviewed cases for dimension ${JSON.stringify(
                  shortSuite.dimensionId
                )}`
          );
        }
      }
      const selectedCaseIds = proposal.suites.map((suite) => ({
        dimensionId: suite.dimensionId,
        caseIds: suite.cases
          .slice(0, scope === "pilot" ? 5 : undefined)
          .map((testCase) => testCase.id)
      }));
      const caseCount = selectedCaseIds.reduce((sum, entry) => sum + entry.caseIds.length, 0);
      const selectedDecompositionCaseIds = proposal.decompositionBenchmark.cases
        .slice(0, scope === "pilot" ? 5 : undefined)
        .map((testCase) => testCase.id);
      const selectedCompositionCaseIds = proposal.compositionSuite.cases
        .slice(0, scope === "pilot" ? 5 : undefined)
        .map((testCase) => testCase.id);
      const expectedDimensionCandidateCalls = caseCount * proposal.candidateModels.length;
      const expectedDimensionJudgeCalls = expectedDimensionCandidateCalls;
      const expectedClassifierCalls = selectedDecompositionCaseIds.length;
      const expectedCompositionCandidateCalls =
        selectedCompositionCaseIds.length * proposal.candidateModels.length;
      const expectedCompositionJudgeCalls = expectedCompositionCandidateCalls;
      const expectedCandidateCalls =
        expectedDimensionCandidateCalls + expectedCompositionCandidateCalls;
      const expectedJudgeCalls = expectedDimensionJudgeCalls + expectedCompositionJudgeCalls;
      const plan: EvalExecutionPlan = {
        version: EVAL_PROJECT_VERSION,
        planId: crypto.randomUUID(),
        projectId: state.projectId,
        projectRevision: state.revision,
        createdAt: yield* isoNow,
        scope,
        basisDigest: state.basisDigest,
        evaluationDigest: state.evaluationDigest,
        candidateModels: state.configuration.candidateModels,
        classifierModel: state.configuration.classifierModel,
        authorModel: state.configuration.authorModel,
        judgeModel: state.configuration.judgeModel,
        selectedCaseIds,
        selectedDecompositionCaseIds,
        selectedCompositionCaseIds,
        maximumOutputTokens: Math.max(
          proposal.compositionSuite.maximumOutputTokens,
          ...proposal.suites.map((suite) => suite.maximumOutputTokens)
        ),
        expectedDimensionCandidateCalls,
        expectedDimensionJudgeCalls,
        expectedClassifierCalls,
        expectedCompositionCandidateCalls,
        expectedCompositionJudgeCalls,
        expectedCandidateCalls,
        expectedJudgeCalls,
        expectedCallCount:
          expectedCandidateCalls + expectedJudgeCalls + expectedClassifierCalls
      };
      yield* artifacts.materializePlanSuites(root, plan, proposal);
      yield* artifacts.savePlan(root, plan);
      return plan;
    });

  const startRun: EvalProjectWorkflowShape["startRun"] = (repositoryRoot, planId) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      const state = yield* loadRequired(root);
      if (state.stage !== "ready" && state.stage !== "qualified") {
        return yield* transitionError(
          state.stage,
          "an eval run requires current approved evaluation artifacts"
        );
      }
      const plan = yield* artifacts.loadPlan(root, planId);
      if (plan === undefined) {
        return yield* transitionError(
          state.stage,
          `execution plan ${JSON.stringify(planId)} does not exist`
        );
      }
      if (
        plan.projectId !== state.projectId ||
        plan.projectRevision !== state.revision ||
        plan.basisDigest !== state.basisDigest ||
        plan.evaluationDigest !== state.evaluationDigest ||
        !sameStrings(plan.candidateModels, state.configuration.candidateModels) ||
        plan.classifierModel !== state.configuration.classifierModel ||
        plan.authorModel !== state.configuration.authorModel ||
        plan.judgeModel !== state.configuration.judgeModel
      ) {
        return yield* transitionError(
          state.stage,
          "execution plan is stale or does not match the approved project"
        );
      }
      const now = yield* isoNow;
      const runId = crypto.randomUUID();
      const next: EvalProjectState = {
        version: state.version,
        projectId: state.projectId,
        revision: state.revision + 1,
        createdAt: state.createdAt,
        updatedAt: now,
        sourceInventory: state.sourceInventory,
        stage: "running",
        configuration: state.configuration,
        basisDigest: state.basisDigest,
        evaluationDigest: state.evaluationDigest,
        planId,
        runId
      };
      yield* store.save(root, next);
      return { plan, runId };
    });

  const finishRun: EvalProjectWorkflowShape["finishRun"] = (repositoryRoot, report) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      const state = yield* loadRequired(root);
      if (
        state.stage !== "running" ||
        (report.status !== "passed" && report.status !== "completed") ||
        report.runId !== state.runId ||
        report.planId !== state.planId ||
        report.projectId !== state.projectId ||
        report.basisDigest !== state.basisDigest ||
        report.evaluationDigest !== state.evaluationDigest
      ) {
        return yield* transitionError(
          state.stage,
          "qualification report does not match the active run"
        );
      }
      if (
        (report.target.kind === "configured"
          ? !report.cleanup.sessionOpened || !report.cleanup.sessionClosed
          : report.cleanup.sessionOpened || report.cleanup.sessionClosed) ||
        report.activation.basisDigest !== state.basisDigest
      ) {
        return yield* transitionError(
          state.stage,
          "a run cannot qualify before session cleanup and activation validation complete"
        );
      }
      const plan = yield* artifacts.loadPlan(root, state.planId);
      if (plan === undefined) {
        return yield* transitionError(state.stage, "the active execution plan is missing");
      }
      const proposal = yield* artifacts.loadEvaluationProposal(root);
      if (
        proposal === undefined ||
        proposal.evaluationDigest !== plan.evaluationDigest ||
        proposal.basisDigest !== plan.basisDigest
      ) {
        return yield* transitionError(
          state.stage,
          "the approved evaluation proposal for the active plan is missing or stale"
        );
      }
      if (
        (plan.scope === "full" && report.status !== "passed") ||
        (plan.scope === "pilot" && report.status !== "completed")
      ) {
        return yield* transitionError(
          state.stage,
          "only full plans may qualify routing activation; pilot plans are completed diagnostics"
        );
      }
      yield* Effect.try({
        try: () => validateQualifiedReport(state, plan, proposal, report),
        catch: (cause) =>
          transitionError(
            state.stage,
            cause instanceof Error ? cause.message : "qualification report is invalid"
          )
      });
      const reportPath = yield* artifacts.saveRunReport(root, report);
      const common = {
        version: state.version,
        projectId: state.projectId,
        revision: state.revision + 1,
        createdAt: state.createdAt,
        updatedAt: report.finishedAt,
        sourceInventory: state.sourceInventory,
        configuration: state.configuration,
        basisDigest: state.basisDigest,
        evaluationDigest: state.evaluationDigest
      } as const;
      const next: EvalProjectState =
        report.status === "passed"
          ? {
              ...common,
              stage: "qualified",
              runId: state.runId,
              reportPath
            }
          : {
              ...common,
              stage: "ready"
            };
      yield* store.save(root, next);
      return yield* statusOf(root, next);
    });

  const failRun: EvalProjectWorkflowShape["failRun"] = (repositoryRoot, report) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      const state = yield* loadRequired(root);
      if (
        state.stage !== "running" ||
        report.status !== "failed" ||
        report.runId !== state.runId ||
        report.planId !== state.planId ||
        report.projectId !== state.projectId ||
        report.basisDigest !== state.basisDigest ||
        report.evaluationDigest !== state.evaluationDigest
      ) {
        return yield* transitionError(state.stage, "failure report does not match the active run");
      }
      yield* artifacts.saveRunReport(root, report);
      const next: EvalProjectState = {
        version: state.version,
        projectId: state.projectId,
        revision: state.revision + 1,
        createdAt: state.createdAt,
        updatedAt: report.finishedAt,
        sourceInventory: state.sourceInventory,
        stage: "ready",
        configuration: state.configuration,
        basisDigest: state.basisDigest,
        evaluationDigest: state.evaluationDigest
      };
      yield* store.save(root, next);
      return yield* statusOf(root, next);
    });

  const result: EvalProjectWorkflowShape["result"] = (repositoryRoot, runId) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      yield* loadRequired(root);
      if (runId !== undefined) return yield* artifacts.loadRunReport(root, runId);
      const reports = yield* artifacts.listRunReports(root);
      let latest: EvalRunReport | undefined;
      for (const reportId of reports) {
        const report = yield* artifacts.loadRunReport(root, reportId);
        if (
          report !== undefined &&
          (latest === undefined || report.finishedAt.localeCompare(latest.finishedAt) > 0)
        ) {
          latest = report;
        }
      }
      return latest;
    });

  const markActivated: EvalProjectWorkflowShape["markActivated"] = (
    repositoryRoot,
    runId,
    targetIdentity
  ) =>
    Effect.gen(function* () {
      const root = resolveRoot(repositoryRoot);
      const state = yield* loadRequired(root);
      if (state.stage !== "qualified" || state.runId !== runId) {
        return yield* transitionError(state.stage, "only the current qualified run may activate");
      }
      const report = yield* artifacts.loadRunReport(root, runId);
      if (
        report?.status !== "passed" ||
        !report.target.publishAllowed ||
        report.target.identity !== targetIdentity
      ) {
        return yield* transitionError(
          state.stage,
          "qualified evidence cannot be published to this target"
        );
      }
      const now = yield* isoNow;
      const next: EvalProjectState = {
        version: state.version,
        projectId: state.projectId,
        revision: state.revision + 1,
        createdAt: state.createdAt,
        updatedAt: now,
        sourceInventory: state.sourceInventory,
        stage: "activated",
        configuration: state.configuration,
        basisDigest: state.basisDigest,
        evaluationDigest: state.evaluationDigest,
        runId,
        reportPath: state.reportPath,
        evidenceDigest: report.activation.evidenceDigest,
        targetIdentity
      };
      yield* store.save(root, next);
      return yield* statusOf(root, next);
    });

  return EvalProjectWorkflow.of({
    setup,
    status,
    answer,
    proposeDimensions,
    approveDimensions,
    proposeEvaluations,
    approveEvaluations,
    createPlan,
    startRun,
    finishRun,
    failRun,
    result,
    markActivated
  });
});

export const EvalProjectWorkflowLive = Layer.effect(EvalProjectWorkflow, makeEvalProjectWorkflow);
