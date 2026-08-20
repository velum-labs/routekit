import { resolve } from "node:path";

import { CliError } from "@velum-labs/routekit-cli-core";
import {
  EVAL_ATTRIBUTION_HEADER,
  EVAL_POLICY,
  EVAL_POLICY_BYPASS_HEADER,
  type EvalComparisonRequest,
  type EvalPolicy,
  type PublishedRoutingActivation,
  type RequestDecomposition,
  WorkloadDimension
} from "@velum-labs/routekit-eval-contracts";
import { scoreRoutingCandidates } from "@velum-labs/routekit-eval-core";
import {
  compileDimensionEvidenceMatrix,
  EvalService,
  makeRouteKitEvalServiceLayer
} from "@velum-labs/routekit-eval-service";
import {
  EVAL_AUTHORING_EVALUATION_OUTPUT_TOKENS,
  type EvalClassifierObservation,
  type EvalCompositionCaseResult,
  EvalCompositionSuiteSchema,
  EvalDecompositionBenchmarkSchema,
  EvalDimensionSuiteSchema,
  type EvalExecutionPlan,
  type EvalPlanScope,
  EvalProjectArtifacts,
  EvalProjectArtifactsLive,
  EvalProjectAuthor,
  EvalProjectAuthorLive,
  type EvalProjectStatus,
  EvalProjectStoreLive,
  EvalProjectWorkflow,
  EvalProjectWorkflowLive,
  EvalRepositoryInspectorLive,
  type EvalRunReport,
  type EvalRunTarget,
  summarizeEvalRunLedger
} from "@velum-labs/routekit-eval-setup";
import { makeLanguageModelDimensionClassifier } from "@velum-labs/routekit-gateway";
import {
  executeWebRequest,
  RouteKitFailure,
  type RouteKitPlatform
} from "@velum-labs/routekit-runtime/effect";
import { trimTrailingSlashes } from "@velum-labs/routekit-runtime/network";
import { Cause, Effect, Exit, FileSystem, Layer, Redacted, Ref, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";

import { routekitClient } from "../client.js";
import { withTargetAuthoringSession } from "./eval-authoring-target.js";
import {
  includeQualificationObservedCalls,
  makeQualificationCleanupRef,
  observeQualificationCalls,
  type QualificationObservedCall,
  type QualificationTarget,
  withQualificationTarget
} from "./eval-execution-target.js";

export type EvalWorkflowCliInput = {
  readonly repositoryRoot?: string;
};

export const DEFAULT_QUALIFICATION_TEST_TIMEOUT_MS = 10 * 60_000;

type QualificationComparisonContext = {
  readonly dimensionId: string;
  readonly timeoutMs: number;
};

export const qualificationComparisonRequest = (input: {
  readonly candidateModels: readonly string[];
  readonly dimensionId: string;
  readonly gatewayUrl: string;
  readonly judgeModel: string;
  readonly suitePath: string;
  readonly timeoutMs?: number;
}): EvalComparisonRequest => ({
  version: 1,
  profileId: input.dimensionId,
  suitePath: input.suitePath,
  candidateModels: input.candidateModels,
  judgeModel: input.judgeModel,
  gatewayUrl: input.gatewayUrl,
  timeoutMs: input.timeoutMs ?? DEFAULT_QUALIFICATION_TEST_TIMEOUT_MS
});

const detailOf = (cause: unknown): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);

export const qualificationFailureDetail = (input: {
  readonly cause: unknown;
  readonly cleanupIncomplete: boolean;
  readonly comparison?: QualificationComparisonContext;
  readonly observedCalls: readonly QualificationObservedCall[];
}): string => {
  const callIds = input.observedCalls.flatMap((call) =>
    call.callId === undefined ? [] : [call.callId]
  );
  const shownCallIds = callIds.slice(0, 20);
  return [
    input.comparison === undefined
      ? "qualification execution failed"
      : `qualification dimension ${JSON.stringify(input.comparison.dimensionId)} failed ` +
        `(per-test timeout ${String(input.comparison.timeoutMs)}ms)`,
    detailOf(input.cause),
    shownCallIds.length === 0
      ? "observed call ids: none"
      : `observed call ids: ${shownCallIds.join(", ")}${
          callIds.length > shownCallIds.length
            ? ` (+${String(callIds.length - shownCallIds.length)} more)`
            : ""
        }`,
    ...(input.cleanupIncomplete ? ["qualification cleanup did not complete"] : [])
  ].join("; ");
};

export const evalQualificationCliError = (failure: string, cause?: unknown): CliError =>
  Object.assign(
    new CliError({
      code: "eval_qualification_failed",
      message: failure,
      exitCode: 1
    }),
    cause === undefined ? {} : { cause }
  );

const EvalProjectWorkflowCliLive = EvalProjectWorkflowLive.pipe(
  Layer.provide(EvalProjectStoreLive),
  Layer.provide(EvalProjectArtifactsLive),
  Layer.provide(EvalRepositoryInspectorLive)
);

const repositoryRoot = (input: EvalWorkflowCliInput): string =>
  resolve(input.repositoryRoot ?? ".");

function withWorkflow<A, E>(
  use: (workflow: EvalProjectWorkflow["Service"]) => Effect.Effect<A, E>
): Effect.Effect<A, E, RouteKitPlatform> {
  return Effect.gen(function* () {
    return yield* use(yield* EvalProjectWorkflow);
  }).pipe(Effect.provide(EvalProjectWorkflowCliLive)) as Effect.Effect<A, E, RouteKitPlatform>;
}

function withArtifacts<A, E>(
  use: (artifacts: EvalProjectArtifacts["Service"]) => Effect.Effect<A, E>
): Effect.Effect<A, E, RouteKitPlatform> {
  return Effect.gen(function* () {
    return yield* use(yield* EvalProjectArtifacts);
  }).pipe(Effect.provide(EvalProjectArtifactsLive)) as Effect.Effect<A, E, RouteKitPlatform>;
}

const readJsonFile = <A>(
  path: string,
  schema: Schema.Schema<A>
): Effect.Effect<A, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const target = resolve(path);
    const info = yield* fs.stat(target);
    if (info.type !== "File" || Number(info.size) > 4 * 1024 * 1024) {
      return yield* new RouteKitFailure({
        message: "eval input must be a regular JSON file no larger than 4 MiB"
      });
    }
    const text = yield* fs.readFileString(target);
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) =>
        new RouteKitFailure({ message: `eval input is not valid JSON: ${String(cause)}` })
    });
    return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new RouteKitFailure({ message: `eval input has the wrong shape: ${String(cause)}` })
      )
    );
  }) as Effect.Effect<A, unknown, FileSystem.FileSystem>;

const DimensionsInput = Schema.Union([
  Schema.Array(WorkloadDimension),
  Schema.Struct({ dimensions: Schema.Array(WorkloadDimension) })
]);

const EvaluationsInput = Schema.Struct({
  suites: Schema.Array(EvalDimensionSuiteSchema),
  decompositionBenchmark: EvalDecompositionBenchmarkSchema,
  compositionSuite: EvalCompositionSuiteSchema
});

export function evalSetupCommand(
  input: EvalWorkflowCliInput
): Effect.Effect<EvalProjectStatus, unknown, RouteKitPlatform> {
  return withWorkflow((workflow) => workflow.setup(repositoryRoot(input)));
}

export function evalStatusCommand(
  input: EvalWorkflowCliInput
): Effect.Effect<EvalProjectStatus | undefined, unknown, RouteKitPlatform> {
  return withWorkflow((workflow) => workflow.status(repositoryRoot(input)));
}

export function evalAnswerCommand(
  input: EvalWorkflowCliInput & { readonly answer?: string; readonly answerFile?: string }
): Effect.Effect<EvalProjectStatus, unknown, RouteKitPlatform> {
  return Effect.gen(function* () {
    const answer =
      input.answer ??
      (input.answerFile === undefined
        ? undefined
        : yield* (yield* FileSystem.FileSystem).readFileString(resolve(input.answerFile)));
    if (answer === undefined || answer.trim().length === 0) {
      return yield* new RouteKitFailure({ message: "eval answer requires non-empty answer text" });
    }
    return yield* withWorkflow((workflow) => workflow.answer(repositoryRoot(input), answer));
  }) as Effect.Effect<EvalProjectStatus, unknown, RouteKitPlatform>;
}

export function evalProposeDimensionsCommand(
  input: EvalWorkflowCliInput & { readonly file?: string }
): Effect.Effect<EvalProjectStatus, unknown, RouteKitPlatform> {
  return Effect.gen(function* () {
    const root = repositoryRoot(input);
    const dimensions =
      input.file === undefined
        ? yield* Effect.gen(function* () {
            const status = yield* withWorkflow((workflow) => workflow.status(root));
            if (status?.state.stage !== "dimensions-review") {
              return yield* new RouteKitFailure({
                message: "eval dimensions can only be authored after setup is complete"
              });
            }
            const state = status.state;
            const operationId = `eval-author-dimensions-${crypto.randomUUID()}`;
            return yield* withTargetAuthoringSession({
              operationId,
              model: state.configuration.authorModel,
              calls: 1,
              maximumOutputTokens: 8_192,
              use: (transport) =>
                Effect.gen(function* () {
                  const author = yield* EvalProjectAuthor;
                  return yield* author.proposeDimensions({
                    operationId,
                    repositoryRoot: root,
                    sourceInventory: state.sourceInventory,
                    configuration: state.configuration
                  });
                }).pipe(Effect.provide(EvalProjectAuthorLive.pipe(Layer.provide(transport))))
            });
          })
        : yield* readJsonFile(input.file, DimensionsInput).pipe(
            Effect.map((decoded) => ("dimensions" in decoded ? decoded.dimensions : decoded))
          );
    return yield* withWorkflow((workflow) => workflow.proposeDimensions(root, dimensions));
  }) as Effect.Effect<EvalProjectStatus, unknown, RouteKitPlatform>;
}

export function evalApproveDimensionsCommand(
  input: EvalWorkflowCliInput & { readonly digest: string }
): Effect.Effect<EvalProjectStatus, unknown, RouteKitPlatform> {
  return withWorkflow((workflow) =>
    workflow.approveDimensions(repositoryRoot(input), input.digest.trim())
  );
}

export function evalProposeEvaluationsCommand(
  input: EvalWorkflowCliInput & { readonly file?: string }
): Effect.Effect<EvalProjectStatus, unknown, RouteKitPlatform> {
  return Effect.gen(function* () {
    const root = repositoryRoot(input);
    const proposal =
      input.file === undefined
        ? yield* Effect.gen(function* () {
            const status = yield* withWorkflow((workflow) => workflow.status(root));
            if (status?.state.stage !== "evaluations-review") {
              return yield* new RouteKitFailure({
                message: "eval evaluations can only be authored after the routing basis is approved"
              });
            }
            const state = status.state;
            const basis = yield* withArtifacts((artifacts) => artifacts.loadBasisProposal(root));
            if (basis === undefined || basis.basisDigest !== state.basisDigest) {
              return yield* new RouteKitFailure({
                message: "the approved routing basis is missing or stale"
              });
            }
            const operationId = `eval-author-evaluations-${crypto.randomUUID()}`;
            return yield* withTargetAuthoringSession({
              operationId,
              model: state.configuration.authorModel,
              calls: basis.dimensions.length + 2,
              maximumOutputTokens: EVAL_AUTHORING_EVALUATION_OUTPUT_TOKENS,
              use: (transport) =>
                Effect.gen(function* () {
                  const author = yield* EvalProjectAuthor;
                  return yield* author.proposeEvaluations({
                    operationId,
                    repositoryRoot: root,
                    sourceInventory: state.sourceInventory,
                    configuration: state.configuration,
                    basis
                  });
                }).pipe(Effect.provide(EvalProjectAuthorLive.pipe(Layer.provide(transport))))
            });
          })
        : yield* readJsonFile(input.file, EvaluationsInput);
    return yield* withWorkflow((workflow) => workflow.proposeEvaluations(root, proposal));
  }) as Effect.Effect<EvalProjectStatus, unknown, RouteKitPlatform>;
}

export function evalApproveEvaluationsCommand(
  input: EvalWorkflowCliInput & { readonly digest: string }
): Effect.Effect<EvalProjectStatus, unknown, RouteKitPlatform> {
  return withWorkflow((workflow) =>
    workflow.approveEvaluations(repositoryRoot(input), input.digest.trim())
  );
}

export function evalValidateCommand(
  input: EvalWorkflowCliInput
): Effect.Effect<EvalProjectStatus, unknown, RouteKitPlatform> {
  return withWorkflow((workflow) =>
    workflow.status(repositoryRoot(input)).pipe(
      Effect.flatMap((status) => {
        if (status === undefined) {
          return Effect.fail(
            new RouteKitFailure({ message: "no eval project exists; run `routekit eval setup`" })
          );
        }
        if (
          status.artifacts?.basisApproved !== true ||
          status.artifacts.evaluationsApproved !== true ||
          !["ready", "qualified", "activated"].includes(status.state.stage)
        ) {
          return Effect.fail(
            new RouteKitFailure({
              message: "eval project does not have current approved dimensions and evaluations"
            })
          );
        }
        return Effect.succeed(status);
      })
    )
  );
}

export function evalEstimateCommand(
  input: EvalWorkflowCliInput & { readonly scope: EvalPlanScope }
): Effect.Effect<EvalExecutionPlan, unknown, RouteKitPlatform> {
  return withWorkflow((workflow) => workflow.createPlan(repositoryRoot(input), input.scope));
}

const vectorL1Error = (
  observed: Readonly<{
    weights: readonly { dimensionId: string; weight: number }[];
    unknownWeight: number;
  }>,
  expected: Readonly<{
    weights: readonly { dimensionId: string; weight: number }[];
    unknownWeight: number;
  }>
): number => {
  const expectedWeights = new Map(
    expected.weights.map((entry) => [entry.dimensionId, entry.weight] as const)
  );
  return (
    observed.weights.reduce(
      (total, entry) =>
        total + Math.abs(entry.weight - (expectedWeights.get(entry.dimensionId) ?? 0)),
      0
    ) + Math.abs(observed.unknownWeight - expected.unknownWeight)
  );
};

const rankedGap = (
  values: readonly Readonly<{ model: string; score: number }>[]
): Readonly<{ winner: string; gap: number }> | undefined => {
  const ranked = [...values].sort(
    (left, right) => right.score - left.score || left.model.localeCompare(right.model)
  );
  const first = ranked[0];
  const second = ranked[1];
  return first === undefined || second === undefined
    ? undefined
    : { winner: first.model, gap: first.score - second.score };
};

export function evalRunCommand(
  input: EvalWorkflowCliInput & {
    readonly planId: string;
    readonly gatewayUrl?: string;
    readonly tokenFile?: string;
    readonly timeoutMs?: number;
  }
): Effect.Effect<EvalRunReport, unknown, RouteKitPlatform> {
  return Effect.gen(function* () {
    const timeoutMs = input.timeoutMs ?? DEFAULT_QUALIFICATION_TEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return yield* new RouteKitFailure({
        message: "eval run timeoutMs must be a positive safe integer"
      });
    }
    const httpClient = yield* HttpClient.HttpClient;
    const httpContext = yield* Effect.context<HttpClient.HttpClient>();
    const root = repositoryRoot(input);
    const startedAt = new Date().toISOString();
    const started = yield* withWorkflow((workflow) => workflow.startRun(root, input.planId));
    const status = yield* withWorkflow((workflow) => workflow.status(root));
    if (status?.state.stage !== "running" || status.state.runId !== started.runId) {
      return yield* new RouteKitFailure({ message: "eval run state was not persisted" });
    }
    const state = status.state;
    const [basis, proposal] = yield* withArtifacts((artifacts) =>
      Effect.all([artifacts.loadBasisProposal(root), artifacts.loadEvaluationProposal(root)])
    );
    if (
      basis === undefined ||
      proposal === undefined ||
      basis.basisDigest !== started.plan.basisDigest ||
      proposal.evaluationDigest !== started.plan.evaluationDigest
    ) {
      return yield* new RouteKitFailure({
        message: "approved eval artifacts are missing or do not match the immutable plan"
      });
    }

    const cleanup = yield* makeQualificationCleanupRef;
    const comparisons = yield* Ref.make<EvalRunReport["comparisons"]>([]);
    const classifierObservations = yield* Ref.make<readonly EvalClassifierObservation[]>([]);
    const observedCalls = yield* Ref.make<readonly QualificationObservedCall[]>([]);
    const activeComparison = yield* Ref.make<QualificationComparisonContext | undefined>(undefined);
    const inspectObservedCall = yield* Ref.make<QualificationTarget["inspectCall"] | undefined>(
      undefined
    );
    const target = yield* Ref.make<EvalRunTarget>(
      input.gatewayUrl === undefined && input.tokenFile === undefined
        ? { kind: "configured", identity: "unresolved", publishAllowed: true }
        : { kind: "external", identity: "unresolved", publishAllowed: false }
    );
    const operationId = `eval-run-${started.runId}`;
    const execution = withQualificationTarget(
      {
        operationId,
        plan: started.plan,
        ...(input.gatewayUrl === undefined ? {} : { gatewayUrl: input.gatewayUrl }),
        ...(input.tokenFile === undefined ? {} : { tokenFile: input.tokenFile })
      },
      cleanup,
      (resolvedTarget) => {
        const instrumentedHttpClient = observeQualificationCalls(httpClient, observedCalls);
        return Effect.gen(function* () {
          yield* Ref.set(target, resolvedTarget.target);
          yield* Ref.set(inspectObservedCall, resolvedTarget.inspectCall);
          const evalService = yield* EvalService;
          const runQualificationComparison = (dimensionId: string, suitePath: string) =>
            Effect.gen(function* () {
              yield* Ref.set(activeComparison, { dimensionId, timeoutMs });
              yield* Ref.set(observedCalls, []);
              const comparison = yield* evalService.runComparison(
                qualificationComparisonRequest({
                  candidateModels: started.plan.candidateModels,
                  dimensionId,
                  gatewayUrl: resolvedTarget.gatewayUrl,
                  judgeModel: started.plan.judgeModel,
                  suitePath,
                  timeoutMs
                }),
                started.plan.scope
              );
              yield* Ref.set(activeComparison, undefined);
              yield* Ref.set(observedCalls, []);
              return comparison;
            });
          for (const selection of started.plan.selectedCaseIds) {
            const suitePath = yield* withArtifacts((artifacts) =>
              artifacts.planSuitePath(root, started.plan.planId, selection.dimensionId)
            );
            const comparison = yield* runQualificationComparison(selection.dimensionId, suitePath);
            yield* Ref.update(comparisons, (completed) => [...completed, comparison]);
          }
          const dimensionComparisons = yield* Ref.get(comparisons);
          const compiled = yield* Effect.try({
            try: () =>
              compileDimensionEvidenceMatrix({
                basis,
                candidateModels: started.plan.candidateModels,
                comparisons: dimensionComparisons.map((comparison) => {
                  const selection = started.plan.selectedCaseIds.find(
                    (entry) => entry.dimensionId === comparison.profileId
                  );
                  if (selection === undefined) {
                    throw new Error("comparison does not match an execution-plan dimension");
                  }
                  return {
                    dimensionId: comparison.profileId,
                    suiteDigest: comparison.suiteDigest,
                    judgeModel: started.plan.judgeModel,
                    expectedCaseIds: selection.caseIds,
                    comparison
                  };
                })
              }),
            catch: (cause) =>
              new RouteKitFailure({
                message: "completed comparison evidence could not be compiled",
                cause
              })
          });
          const activation: PublishedRoutingActivation = {
            version: 2,
            generatedAt: new Date().toISOString(),
            basisDigest: basis.basisDigest,
            evidenceDigest: compiled.evidenceDigest,
            classifierModel: started.plan.classifierModel,
            objective: state.configuration.objective,
            maximumUnknownWeight: state.configuration.maximumUnknownWeight,
            ...(state.configuration.constraints === undefined
              ? {}
              : { constraints: state.configuration.constraints }),
            dimensions: basis.dimensions,
            candidateModels: started.plan.candidateModels,
            evidence: compiled.evidence
          };

          const selectedDecompositionCases = yield* Effect.forEach(
            started.plan.selectedDecompositionCaseIds,
            (caseId) => {
              const benchmarkCase = proposal.decompositionBenchmark.cases.find(
                (entry) => entry.id === caseId
              );
              if (benchmarkCase === undefined) {
                return Effect.fail(
                  new RouteKitFailure({
                    message: "execution plan refers to an unknown decomposition case"
                  })
                );
              }
              return Effect.succeed(benchmarkCase);
            }
          );
          for (const benchmarkCase of selectedDecompositionCases) {
            const responseMeasurement = yield* Ref.make<EvalClassifierObservation["measurement"]>(
              {}
            );
            const classifier = makeLanguageModelDimensionClassifier({
              model: started.plan.classifierModel,
              complete: (body, signal) =>
                executeWebRequest(
                  `${trimTrailingSlashes(resolvedTarget.gatewayUrl)}/v1/chat/completions`,
                  {
                    method: "POST",
                    redirect: "manual",
                    headers: {
                      authorization: `Bearer ${Redacted.value(resolvedTarget.bearerCredential)}`,
                      "content-type": "application/json",
                      [EVAL_POLICY_BYPASS_HEADER]: "1",
                      [EVAL_ATTRIBUTION_HEADER]: JSON.stringify({
                        purpose: "eval",
                        role: "classifier",
                        runId: started.runId,
                        caseId: benchmarkCase.id
                      })
                    },
                    body: JSON.stringify(body),
                    ...(signal === undefined ? {} : { signal })
                  }
                ).pipe(
                  Effect.tap((response) =>
                    Effect.tryPromise({
                      try: () =>
                        response.clone().json() as Promise<{
                          usage?: {
                            prompt_tokens?: unknown;
                            completion_tokens?: unknown;
                            costUsd?: unknown;
                          };
                        }>,
                      catch: () => undefined
                    }).pipe(
                      Effect.flatMap((payload) => {
                        const usage = payload.usage;
                        return Ref.set(responseMeasurement, {
                          ...(typeof usage?.prompt_tokens === "number"
                            ? { inputTokens: usage.prompt_tokens }
                            : {}),
                          ...(typeof usage?.completion_tokens === "number"
                            ? { outputTokens: usage.completion_tokens }
                            : {}),
                          ...(typeof usage?.costUsd === "number" ? { costUsd: usage.costUsd } : {})
                        });
                      }),
                      Effect.ignore
                    )
                  ),
                  Effect.mapError(
                    (cause) =>
                      new RouteKitFailure({
                        message: "classifier request transport failed",
                        cause
                      })
                  ),
                  Effect.provide(httpContext)
                )
            });
            const observed = yield* classifier.classify({
              request: benchmarkCase.request,
              dimensions: basis.dimensions
            });
            const error = vectorL1Error(observed, benchmarkCase.expected);
            const inspected =
              observed.classifierCallId === undefined || resolvedTarget.inspectCall === undefined
                ? yield* Ref.get(responseMeasurement)
                : yield* resolvedTarget.inspectCall(observed.classifierCallId);
            const observation: EvalClassifierObservation = {
              caseId: benchmarkCase.id,
              weights: observed.weights,
              unknownWeight: observed.unknownWeight,
              vectorL1Error: error,
              passed: error <= proposal.decompositionBenchmark.maximumVectorL1Error,
              ...(observed.classifierCallId === undefined
                ? {}
                : { classifierCallId: observed.classifierCallId }),
              measurement: inspected
            };
            yield* Ref.update(classifierObservations, (current) => [...current, observation]);
            if (!observation.passed) {
              return yield* new RouteKitFailure({
                message: "request decomposition benchmark did not meet its reviewed threshold"
              });
            }
          }

          const compositionSuitePath = yield* withArtifacts((artifacts) =>
            artifacts.compositionSuitePath(root, started.plan.planId)
          );
          const compositionComparison = yield* runQualificationComparison(
            "composition",
            compositionSuitePath
          );
          yield* Ref.update(comparisons, (current) => [...current, compositionComparison]);

          const compositionCases: EvalCompositionCaseResult[] = [];
          for (const caseId of started.plan.selectedCompositionCaseIds) {
            const benchmarkCase = proposal.compositionSuite.cases.find(
              (entry) => entry.id === caseId
            );
            if (benchmarkCase === undefined) {
              return yield* new RouteKitFailure({
                message: "execution plan refers to an unknown composition case"
              });
            }
            const decomposition: RequestDecomposition = {
              version: 2,
              basisDigest: basis.basisDigest,
              weights: benchmarkCase.decomposition.weights,
              unknownWeight: benchmarkCase.decomposition.unknownWeight
            };
            const scored = yield* Effect.try({
              try: () =>
                scoreRoutingCandidates({
                  snapshot: activation,
                  decomposition,
                  requirements: benchmarkCase.requirements,
                  objective: { kind: "highest-quality" },
                  availableModels: started.plan.candidateModels.map((model) => ({
                    model,
                    served: true,
                    endpoints: ["chat", "responses", "anthropic"] as const,
                    supportsTools: true,
                    supportsVision: true
                  })),
                  ...(state.configuration.constraints === undefined
                    ? {}
                    : { constraints: state.configuration.constraints })
                }),
              catch: (cause) =>
                new RouteKitFailure({
                  message: "composition benchmark could not score the evidence matrix",
                  cause
                })
            });
            const predicted = rankedGap(
              scored.candidates.flatMap((candidate) =>
                candidate.eligible && candidate.quality !== undefined
                  ? [{ model: candidate.model, score: candidate.quality }]
                  : []
              )
            );
            const observed = rankedGap(
              compositionComparison.models.flatMap((model) => {
                const result = model.cases.find((entry) => entry.caseId === caseId);
                return result?.measurement.judgeScore === undefined
                  ? []
                  : [{ model: model.model, score: result.measurement.judgeScore }];
              })
            );
            if (predicted === undefined || observed === undefined) {
              return yield* new RouteKitFailure({
                message: "composition benchmark evidence is incomplete"
              });
            }
            const comparable =
              predicted.gap >= proposal.compositionSuite.minimumWinnerScoreGap &&
              observed.gap >= proposal.compositionSuite.minimumWinnerScoreGap;
            compositionCases.push({
              caseId,
              predictedWinner: predicted.winner,
              observedWinner: observed.winner,
              predictedScoreGap: predicted.gap,
              observedScoreGap: observed.gap,
              passed: comparable && predicted.winner === observed.winner
            });
          }
          const comparableCases = compositionCases.filter(
            (entry) =>
              entry.predictedScoreGap >= proposal.compositionSuite.minimumWinnerScoreGap &&
              entry.observedScoreGap >= proposal.compositionSuite.minimumWinnerScoreGap
          );
          const agreeingCases = comparableCases.filter((entry) => entry.passed);
          const winnerAgreement =
            comparableCases.length === 0 ? 0 : agreeingCases.length / comparableCases.length;
          if (
            comparableCases.length === 0 ||
            winnerAgreement < proposal.compositionSuite.minimumWinnerAgreement
          ) {
            return yield* new RouteKitFailure({
              message: "composition benchmark did not meet its reviewed winner-agreement threshold"
            });
          }
          const observations = yield* Ref.get(classifierObservations);
          return {
            activation,
            qualification: {
              decomposition: {
                expectedCases: selectedDecompositionCases.length,
                passedCases: observations.filter((entry) => entry.passed).length,
                maximumObservedL1Error: Math.max(
                  0,
                  ...observations.map((entry) => entry.vectorL1Error)
                ),
                observations
              },
              composition: {
                expectedCases: compositionCases.length,
                comparableCases: comparableCases.length,
                agreeingCases: agreeingCases.length,
                winnerAgreement,
                cases: compositionCases
              }
            }
          };
        }).pipe(
          Effect.provide(
            makeRouteKitEvalServiceLayer(
              {},
              {
                bearerCredential: Redacted.value(resolvedTarget.bearerCredential),
                isolateExecutionFromProjectSdk: true,
                timeoutMs
              }
            )
          ),
          Effect.provideService(HttpClient.HttpClient, instrumentedHttpClient)
        );
      }
    );
    const exit = yield* Effect.exit(execution);
    const finishedAt = new Date().toISOString();
    const completed = yield* Ref.get(comparisons);
    const finalCleanup = yield* Ref.get(cleanup);
    const finalTarget = yield* Ref.get(target);
    const finalClassifierObservations = yield* Ref.get(classifierObservations);
    const finalObservedCalls = yield* Ref.get(observedCalls);
    const inspector = yield* Ref.get(inspectObservedCall);
    const inspectedObservedCalls =
      Exit.isFailure(exit) && inspector !== undefined
        ? yield* Effect.forEach(
            finalObservedCalls,
            (call) =>
              call.callId === undefined
                ? Effect.succeed(call)
                : inspector(call.callId).pipe(
                    Effect.map((measurement) => ({ ...call, measurement })),
                    Effect.orElseSucceed(() => call)
                  ),
            { concurrency: 4 }
          )
        : finalObservedCalls;
    const ledger = includeQualificationObservedCalls(
      summarizeEvalRunLedger(
        completed,
        started.plan.expectedCallCount,
        finalClassifierObservations
      ),
      Exit.isFailure(exit) ? inspectedObservedCalls : []
    );
    if (Exit.isSuccess(exit)) {
      const report: EvalRunReport = {
        version: 1,
        runId: started.runId,
        planId: started.plan.planId,
        projectId: state.projectId,
        startedAt,
        finishedAt,
        basisDigest: started.plan.basisDigest,
        evaluationDigest: started.plan.evaluationDigest,
        target: finalTarget,
        cleanup: finalCleanup,
        comparisons: completed,
        qualification: exit.value.qualification,
        ledger,
        status: started.plan.scope === "full" ? "passed" : "completed",
        activation: exit.value.activation
      };
      yield* withWorkflow((workflow) => workflow.finishRun(root, report));
      return report;
    }
    const cause = Cause.squash(exit.cause);
    const finalActiveComparison = yield* Ref.get(activeComparison);
    const failure = qualificationFailureDetail({
      cause,
      cleanupIncomplete: finalCleanup.sessionOpened && !finalCleanup.sessionClosed,
      ...(finalActiveComparison === undefined ? {} : { comparison: finalActiveComparison }),
      observedCalls: inspectedObservedCalls
    });
    const report: EvalRunReport = {
      version: 1,
      runId: started.runId,
      planId: started.plan.planId,
      projectId: state.projectId,
      startedAt,
      finishedAt,
      basisDigest: started.plan.basisDigest,
      evaluationDigest: started.plan.evaluationDigest,
      target: finalTarget,
      cleanup: finalCleanup,
      comparisons: completed,
      ledger,
      status: "failed",
      failure
    };
    yield* withWorkflow((workflow) => workflow.failRun(root, report));
    return yield* Effect.fail(evalQualificationCliError(failure, cause));
  }) as Effect.Effect<EvalRunReport, unknown, RouteKitPlatform>;
}

export function evalResultsCommand(
  input: EvalWorkflowCliInput & { readonly runId?: string }
): Effect.Effect<EvalRunReport, unknown, RouteKitPlatform> {
  return withWorkflow((workflow) =>
    workflow
      .result(repositoryRoot(input), input.runId)
      .pipe(
        Effect.flatMap((report) =>
          report === undefined
            ? Effect.fail(new RouteKitFailure({ message: "no eval run report was found" }))
            : Effect.succeed(report)
        )
      )
  );
}

export function evalPublishCommand(
  input: EvalWorkflowCliInput & { readonly runId: string }
): Effect.Effect<EvalProjectStatus, unknown, RouteKitPlatform> {
  return Effect.gen(function* () {
    const root = repositoryRoot(input);
    const report = yield* withWorkflow((workflow) => workflow.result(root, input.runId));
    if (report?.status !== "passed" || !report.target.publishAllowed) {
      return yield* new RouteKitFailure({
        message: "only a full run qualified on the configured RouteKit target may be published"
      });
    }
    const client = yield* routekitClient;
    const current = yield* client.call("evalRouting.status", {});
    yield* client.call(
      "evalRouting.activate",
      {
        expectedEvidenceDigest: current.activation?.evidenceDigest ?? null,
        activation: report.activation
      },
      { idempotencyKey: `activate-${report.runId}` }
    );
    return yield* withWorkflow((workflow) =>
      workflow.markActivated(root, report.runId, report.target.identity)
    );
  }) as Effect.Effect<EvalProjectStatus, unknown, RouteKitPlatform>;
}

export const policyShowCommand: Effect.Effect<EvalPolicy> = Effect.succeed(EVAL_POLICY);
