import { createHash } from "node:crypto";

import {
  assertRoutingBasis,
  type RoutingBasis
} from "@velum-labs/routekit-eval-contracts";
import { writeFileAtomicEffect } from "@velum-labs/routekit-runtime/effect";
import { Context, Effect, Exit, FileSystem, Layer, Path, Schema } from "effect";

import { EvalProjectArtifactError } from "./errors.js";
import {
  EVAL_PROJECT_VERSION,
  type EvalArtifactApproval,
  EvalArtifactApproval as EvalArtifactApprovalSchema,
  type EvalDimensionSuite,
  type EvalEvaluationProposal,
  EvalEvaluationProposal as EvalEvaluationProposalSchema,
  type EvalExecutionPlan,
  EvalExecutionPlan as EvalExecutionPlanSchema,
  type EvalRoutingBasisProposal,
  EvalRoutingBasisProposal as EvalRoutingBasisProposalSchema,
  type EvalRunReport,
  EvalRunReport as EvalRunReportSchema
} from "./project-contracts.js";

const BASIS_PROPOSAL = "routing-basis.proposed.json";
const BASIS_APPROVAL = "routing-basis.approval.json";
const EVALUATIONS_PROPOSAL = "evaluations.proposed.json";
const EVALUATIONS_APPROVAL = "evaluations.approval.json";
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

const renderDimensionSuite = (): string => `import assert from "node:assert/strict";
import { test } from "node:test";
import { setupAgent, setupJudge } from "routekit/eval";
import cases from "./data/cases.json" with { type: "json" };
import manifest from "./routekit.eval-manifest.json" with { type: "json" };

assert.equal(cases.length, manifest.caseCount);
assert.deepEqual(cases.map((testCase) => testCase.id), manifest.caseIds);
const judge = setupJudge({
  agent: setupAgent({ model: manifest.judgeModel }),
  minScore: 0.8
});

for (const model of manifest.candidateModels) {
  const candidate = setupAgent({ model });
  for (const testCase of cases) {
    test(\`\${model} / \${testCase.id}\`, async () => {
      const prompt = testCase.context === undefined
        ? testCase.prompt
        : [testCase.prompt, "", "Reference material:", "-----", testCase.context, "-----"].join("\\n");
      const run = await candidate.run({ prompt, caseId: testCase.id });
      run.toComplete();
      await judge.autoEvals({ criteria: testCase.rubric, prompt, run });
    });
  }
}
`;

const detailOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const artifactFailure = (
  operation: EvalProjectArtifactError["operation"],
  path: string,
  cause: unknown
): EvalProjectArtifactError =>
  new EvalProjectArtifactError({
    operation,
    path,
    detail: detailOf(cause),
    cause
  });

const requireArtifactId = (
  kind: "plan" | "run",
  id: string
): Effect.Effect<void, EvalProjectArtifactError> =>
  ARTIFACT_ID.test(id)
    ? Effect.void
    : Effect.fail(
        artifactFailure(
          "reading",
          id,
          new Error(`${kind} id must be a bounded identifier, not a path`)
        )
      );

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function routingBasisDigest(dimensions: RoutingBasis["dimensions"]): string {
  return digest({ version: 2, dimensions });
}

export function evaluationProposalDigest(
  proposal: Omit<EvalEvaluationProposal, "evaluationDigest">
): string {
  return digest(proposal);
}

function assertEvaluationProposal(proposal: EvalEvaluationProposal): void {
  if (
    proposal.evaluationDigest !==
    evaluationProposalDigest({
      version: proposal.version,
      basisDigest: proposal.basisDigest,
      candidateModels: proposal.candidateModels,
      judgeModel: proposal.judgeModel,
      suites: proposal.suites,
      decompositionBenchmark: proposal.decompositionBenchmark,
      compositionSuite: proposal.compositionSuite
    })
  ) {
    throw new Error("evaluation proposal digest does not match its contents");
  }
  if (proposal.candidateModels.length < 2) {
    throw new Error("evaluation proposal requires at least two candidate models");
  }
  if (new Set(proposal.candidateModels).size !== proposal.candidateModels.length) {
    throw new Error("evaluation proposal candidate models must be unique");
  }
  if (proposal.judgeModel.trim().length === 0) {
    throw new Error("evaluation proposal judge must be explicit");
  }
  const dimensions = new Set<string>();
  for (const suite of proposal.suites) {
    if (dimensions.has(suite.dimensionId)) {
      throw new Error(`duplicate dimension suite ${JSON.stringify(suite.dimensionId)}`);
    }
    dimensions.add(suite.dimensionId);
    assertDimensionSuite(suite);
  }
  if (
    proposal.decompositionBenchmark.maximumVectorL1Error < 0 ||
    proposal.decompositionBenchmark.maximumVectorL1Error > 2 ||
    proposal.decompositionBenchmark.cases.length < 5
  ) {
    throw new Error("decomposition benchmark must define a reviewed threshold and at least five cases");
  }
  if (
    proposal.compositionSuite.maximumOutputTokens < 1 ||
    proposal.compositionSuite.minimumWinnerScoreGap < 0 ||
    proposal.compositionSuite.minimumWinnerScoreGap > 1 ||
    proposal.compositionSuite.minimumWinnerAgreement < 0 ||
    proposal.compositionSuite.minimumWinnerAgreement > 1 ||
    proposal.compositionSuite.cases.length < 5
  ) {
    throw new Error("composition benchmark must define reviewed thresholds and at least five cases");
  }
  for (const [label, cases] of [
    ["decomposition", proposal.decompositionBenchmark.cases],
    ["composition", proposal.compositionSuite.cases]
  ] as const) {
    const ids = new Set<string>();
    for (const testCase of cases) {
      if (testCase.id.trim().length === 0 || ids.has(testCase.id)) {
        throw new Error(`${label} benchmark contains an invalid or duplicate case id`);
      }
      ids.add(testCase.id);
    }
  }
}

function assertDimensionSuite(suite: EvalDimensionSuite): void {
  if (suite.maximumOutputTokens < 1) {
    throw new Error(`dimension suite ${JSON.stringify(suite.dimensionId)} has no output allowance`);
  }
  if (suite.cases.length < 5) {
    throw new Error(
      `dimension suite ${JSON.stringify(suite.dimensionId)} must contain at least five cases`
    );
  }
  const ids = new Set<string>();
  for (const testCase of suite.cases) {
    if (
      testCase.id.trim().length === 0 ||
      testCase.prompt.trim().length === 0 ||
      testCase.rubric.trim().length === 0
    ) {
      throw new Error(
        `dimension suite ${JSON.stringify(suite.dimensionId)} contains an incomplete case`
      );
    }
    if (ids.has(testCase.id)) {
      throw new Error(
        `dimension suite ${JSON.stringify(suite.dimensionId)} contains duplicate case ${JSON.stringify(
          testCase.id
        )}`
      );
    }
    ids.add(testCase.id);
  }
}

export type EvalProjectArtifactsShape = {
  readonly loadBasisProposal: (
    repositoryRoot: string
  ) => Effect.Effect<EvalRoutingBasisProposal | undefined, EvalProjectArtifactError, never>;
  readonly saveBasisProposal: (
    repositoryRoot: string,
    basis: EvalRoutingBasisProposal
  ) => Effect.Effect<void, EvalProjectArtifactError, never>;
  readonly loadBasisApproval: (
    repositoryRoot: string
  ) => Effect.Effect<EvalArtifactApproval | undefined, EvalProjectArtifactError, never>;
  readonly saveBasisApproval: (
    repositoryRoot: string,
    approval: EvalArtifactApproval
  ) => Effect.Effect<void, EvalProjectArtifactError, never>;
  readonly loadEvaluationProposal: (
    repositoryRoot: string
  ) => Effect.Effect<EvalEvaluationProposal | undefined, EvalProjectArtifactError, never>;
  readonly saveEvaluationProposal: (
    repositoryRoot: string,
    proposal: EvalEvaluationProposal
  ) => Effect.Effect<void, EvalProjectArtifactError, never>;
  readonly loadEvaluationsApproval: (
    repositoryRoot: string
  ) => Effect.Effect<EvalArtifactApproval | undefined, EvalProjectArtifactError, never>;
  readonly saveEvaluationsApproval: (
    repositoryRoot: string,
    approval: EvalArtifactApproval
  ) => Effect.Effect<void, EvalProjectArtifactError, never>;
  readonly savePlan: (
    repositoryRoot: string,
    plan: EvalExecutionPlan
  ) => Effect.Effect<void, EvalProjectArtifactError, never>;
  readonly materializePlanSuites: (
    repositoryRoot: string,
    plan: EvalExecutionPlan,
    proposal: EvalEvaluationProposal
  ) => Effect.Effect<void, EvalProjectArtifactError, never>;
  readonly planSuitePath: (
    repositoryRoot: string,
    planId: string,
    dimensionId: string
  ) => Effect.Effect<string, EvalProjectArtifactError, never>;
  readonly compositionSuitePath: (
    repositoryRoot: string,
    planId: string
  ) => Effect.Effect<string, EvalProjectArtifactError, never>;
  readonly loadPlan: (
    repositoryRoot: string,
    planId: string
  ) => Effect.Effect<EvalExecutionPlan | undefined, EvalProjectArtifactError, never>;
  readonly listPlans: (
    repositoryRoot: string
  ) => Effect.Effect<readonly string[], EvalProjectArtifactError, never>;
  readonly saveRunReport: (
    repositoryRoot: string,
    report: EvalRunReport
  ) => Effect.Effect<string, EvalProjectArtifactError, never>;
  readonly loadRunReport: (
    repositoryRoot: string,
    runId: string
  ) => Effect.Effect<EvalRunReport | undefined, EvalProjectArtifactError, never>;
  readonly listRunReports: (
    repositoryRoot: string
  ) => Effect.Effect<readonly string[], EvalProjectArtifactError, never>;
};

export class EvalProjectArtifacts extends Context.Service<
  EvalProjectArtifacts,
  EvalProjectArtifactsShape
>()("@velum-labs/routekit-eval-setup/EvalProjectArtifacts") {}

export const makeFileEvalProjectArtifacts = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  const root = (repositoryRoot: string): string =>
    paths.join(paths.resolve(repositoryRoot), ".routekit", "evals");
  const artifactPath = (repositoryRoot: string, name: string): string =>
    paths.join(root(repositoryRoot), name);

  const writeAtomic = (
    target: string,
    content: string
  ): Effect.Effect<void, EvalProjectArtifactError, never> =>
    writeFileAtomicEffect(target, content, {
      mode: 0o600
    }).pipe(
      Effect.mapError((cause) => artifactFailure("writing", target, cause)),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, paths)
    ) as Effect.Effect<void, EvalProjectArtifactError, never>;

  const read = <A>(
    repositoryRoot: string,
    name: string,
    decode: (value: unknown) => Effect.Effect<A, unknown, never>
  ): Effect.Effect<A | undefined, EvalProjectArtifactError> =>
    Effect.gen(function* () {
      const target = artifactPath(repositoryRoot, name);
      const exists = yield* fs
        .exists(target)
        .pipe(Effect.mapError((cause) => artifactFailure("checking", target, cause)));
      if (!exists) return undefined;
      const raw = yield* fs
        .readFileString(target)
        .pipe(Effect.mapError((cause) => artifactFailure("reading", target, cause)));
      const value = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) => artifactFailure("decoding", target, cause)
      });
      return yield* decode(value).pipe(
        Effect.mapError((cause) => artifactFailure("decoding", target, cause))
      );
    });

  const writeText = (
    repositoryRoot: string,
    name: string,
    content: string,
    overwrite = true
  ): Effect.Effect<void, EvalProjectArtifactError, never> =>
    Effect.gen(function* () {
      const target = artifactPath(repositoryRoot, name);
      const exists = yield* fs
        .exists(target)
        .pipe(Effect.mapError((cause) => artifactFailure("checking", target, cause)));
      if (!overwrite && exists) {
        return yield* artifactFailure("writing", target, new Error("artifact already exists"));
      }
      yield* fs
        .makeDirectory(paths.dirname(target), { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError((cause) => artifactFailure("writing", target, cause)));
      yield* writeAtomic(target, content);
    });

  const write = (
    repositoryRoot: string,
    name: string,
    value: unknown,
    overwrite = true
  ): Effect.Effect<void, EvalProjectArtifactError, never> =>
    writeText(repositoryRoot, name, `${JSON.stringify(value, null, 2)}\n`, overwrite);

  return EvalProjectArtifacts.of({
    loadBasisProposal: (repositoryRoot) =>
      read<EvalRoutingBasisProposal>(
        repositoryRoot,
        BASIS_PROPOSAL,
        Schema.decodeUnknownEffect(EvalRoutingBasisProposalSchema)
      ).pipe(
        Effect.tap((basis) =>
          basis === undefined
            ? Effect.void
            : Effect.try({
                try: () => {
                  assertRoutingBasis(basis);
                  if (basis.basisDigest !== routingBasisDigest(basis.dimensions)) {
                    throw new Error("routing basis digest does not match its dimensions");
                  }
                },
                catch: (cause) =>
                  artifactFailure("decoding", artifactPath(repositoryRoot, BASIS_PROPOSAL), cause)
              })
        )
      ),
    saveBasisProposal: (repositoryRoot, basis) =>
      Effect.try({
        try: () => {
          assertRoutingBasis(basis);
          if (basis.basisDigest !== routingBasisDigest(basis.dimensions)) {
            throw new Error("routing basis digest does not match its dimensions");
          }
        },
        catch: (cause) =>
          artifactFailure("writing", artifactPath(repositoryRoot, BASIS_PROPOSAL), cause)
      }).pipe(Effect.andThen(write(repositoryRoot, BASIS_PROPOSAL, basis))),
    loadBasisApproval: (repositoryRoot) =>
      read(repositoryRoot, BASIS_APPROVAL, Schema.decodeUnknownEffect(EvalArtifactApprovalSchema)),
    saveBasisApproval: (repositoryRoot, approval) =>
      write(repositoryRoot, BASIS_APPROVAL, approval),
    loadEvaluationProposal: (repositoryRoot) =>
      read<EvalEvaluationProposal>(
        repositoryRoot,
        EVALUATIONS_PROPOSAL,
        Schema.decodeUnknownEffect(EvalEvaluationProposalSchema)
      ).pipe(
        Effect.tap((proposal) =>
          proposal === undefined
            ? Effect.void
            : Effect.try({
                try: () => assertEvaluationProposal(proposal),
                catch: (cause) =>
                  artifactFailure(
                    "decoding",
                    artifactPath(repositoryRoot, EVALUATIONS_PROPOSAL),
                    cause
                  )
              })
        )
      ),
    saveEvaluationProposal: (repositoryRoot, proposal) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => assertEvaluationProposal(proposal),
          catch: (cause) =>
            artifactFailure("writing", artifactPath(repositoryRoot, EVALUATIONS_PROPOSAL), cause)
        });
        yield* write(repositoryRoot, EVALUATIONS_PROPOSAL, proposal);
        for (const suite of proposal.suites) {
          const suiteRoot = paths.join("dimensions", suite.dimensionId);
          yield* write(repositoryRoot, paths.join(suiteRoot, "suite.json"), suite);
          yield* writeText(
            repositoryRoot,
            paths.join(suiteRoot, `${suite.dimensionId}.eval.ts`),
            renderDimensionSuite()
          );
          yield* write(repositoryRoot, paths.join(suiteRoot, "data", "cases.json"), suite.cases);
          yield* write(repositoryRoot, paths.join(suiteRoot, "routekit.eval-manifest.json"), {
            version: EVAL_PROJECT_VERSION,
            profileId: suite.dimensionId,
            candidateModels: proposal.candidateModels,
            judgeModel: proposal.judgeModel,
            caseCount: suite.cases.length,
            caseIds: suite.cases.map((testCase) => testCase.id),
            maxOutputTokens: suite.maximumOutputTokens,
            expectedCallCount: suite.cases.length * proposal.candidateModels.length * 2
          });
        }
        yield* write(
          repositoryRoot,
          paths.join("benchmarks", "decomposition.json"),
          proposal.decompositionBenchmark
        );
        yield* write(
          repositoryRoot,
          paths.join("benchmarks", "composition.json"),
          proposal.compositionSuite
        );
      }),
    loadEvaluationsApproval: (repositoryRoot) =>
      read(
        repositoryRoot,
        EVALUATIONS_APPROVAL,
        Schema.decodeUnknownEffect(EvalArtifactApprovalSchema)
      ),
    saveEvaluationsApproval: (repositoryRoot, approval) =>
      write(repositoryRoot, EVALUATIONS_APPROVAL, approval),
    savePlan: (repositoryRoot, plan) =>
      write(repositoryRoot, paths.join("plans", `${plan.planId}.json`), plan, false),
    materializePlanSuites: (repositoryRoot, plan, proposal) =>
      Effect.gen(function* () {
        yield* requireArtifactId("plan", plan.planId);
        const suites = new Map(proposal.suites.map((suite) => [suite.dimensionId, suite] as const));
        for (const selection of plan.selectedCaseIds) {
          if (!ARTIFACT_ID.test(selection.dimensionId)) {
            return yield* artifactFailure(
              "writing",
              selection.dimensionId,
              new Error("dimension id must be a bounded identifier, not a path")
            );
          }
          const suite = suites.get(selection.dimensionId);
          if (suite === undefined) {
            return yield* artifactFailure(
              "writing",
              selection.dimensionId,
              new Error("execution plan refers to an unknown dimension suite")
            );
          }
          const byId = new Map(suite.cases.map((testCase) => [testCase.id, testCase] as const));
          const cases = selection.caseIds.map((caseId) => {
            const testCase = byId.get(caseId);
            if (testCase === undefined) {
              throw new Error(
                `execution plan refers to unknown case ${JSON.stringify(caseId)} in ${JSON.stringify(
                  selection.dimensionId
                )}`
              );
            }
            return testCase;
          });
          const suiteRoot = paths.join(
            "plans",
            plan.planId,
            "dimensions",
            selection.dimensionId
          );
          yield* writeText(
            repositoryRoot,
            paths.join(suiteRoot, `${selection.dimensionId}.eval.ts`),
            renderDimensionSuite(),
            false
          );
          yield* write(
            repositoryRoot,
            paths.join(suiteRoot, "data", "cases.json"),
            cases,
            false
          );
          yield* write(
            repositoryRoot,
            paths.join(suiteRoot, "routekit.eval-manifest.json"),
            {
              version: EVAL_PROJECT_VERSION,
              profileId: selection.dimensionId,
              candidateModels: plan.candidateModels,
              judgeModel: plan.judgeModel,
              caseCount: cases.length,
              caseIds: cases.map((testCase) => testCase.id),
              maxOutputTokens: suite.maximumOutputTokens,
              expectedCallCount: cases.length * plan.candidateModels.length * 2
            },
            false
          );
        }
        const compositionById = new Map(
          proposal.compositionSuite.cases.map((testCase) => [testCase.id, testCase] as const)
        );
        const compositionCases = plan.selectedCompositionCaseIds.map((caseId) => {
          const testCase = compositionById.get(caseId);
          if (testCase === undefined) {
            throw new Error(
              `execution plan refers to unknown composition case ${JSON.stringify(caseId)}`
            );
          }
          return testCase;
        });
        const compositionRoot = paths.join("plans", plan.planId, "composition");
        yield* writeText(
          repositoryRoot,
          paths.join(compositionRoot, "composition.eval.ts"),
          renderDimensionSuite(),
          false
        );
        yield* write(
          repositoryRoot,
          paths.join(compositionRoot, "data", "cases.json"),
          compositionCases,
          false
        );
        yield* write(
          repositoryRoot,
          paths.join(compositionRoot, "routekit.eval-manifest.json"),
          {
            version: EVAL_PROJECT_VERSION,
            profileId: "composition",
            candidateModels: plan.candidateModels,
            judgeModel: plan.judgeModel,
            caseCount: compositionCases.length,
            caseIds: compositionCases.map((testCase) => testCase.id),
            maxOutputTokens: proposal.compositionSuite.maximumOutputTokens,
            expectedCallCount: compositionCases.length * plan.candidateModels.length * 2
          },
          false
        );
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof EvalProjectArtifactError
            ? cause
            : artifactFailure(
                "writing",
                artifactPath(repositoryRoot, paths.join("plans", plan.planId)),
                cause
              )
        )
      ),
    planSuitePath: (repositoryRoot, planId, dimensionId) =>
      Effect.gen(function* () {
        yield* requireArtifactId("plan", planId);
        if (!ARTIFACT_ID.test(dimensionId)) {
          return yield* artifactFailure(
            "reading",
            dimensionId,
            new Error("dimension id must be a bounded identifier, not a path")
          );
        }
        return artifactPath(
          repositoryRoot,
          paths.join(
            "plans",
            planId,
            "dimensions",
            dimensionId,
            `${dimensionId}.eval.ts`
          )
        );
      }),
    compositionSuitePath: (repositoryRoot, planId) =>
      requireArtifactId("plan", planId).pipe(
        Effect.as(
          artifactPath(
            repositoryRoot,
            paths.join("plans", planId, "composition", "composition.eval.ts")
          )
        )
      ),
    loadPlan: (repositoryRoot, planId) =>
      requireArtifactId("plan", planId).pipe(
        Effect.andThen(
          read(
            repositoryRoot,
            paths.join("plans", `${planId}.json`),
            Schema.decodeUnknownEffect(EvalExecutionPlanSchema)
          )
        )
      ),
    listPlans: (repositoryRoot) =>
      Effect.gen(function* () {
        const directory = artifactPath(repositoryRoot, "plans");
        const exists = yield* fs
          .exists(directory)
          .pipe(Effect.mapError((cause) => artifactFailure("checking", directory, cause)));
        if (!exists) return [];
        const entries = yield* fs
          .readDirectory(directory)
          .pipe(Effect.mapError((cause) => artifactFailure("listing", directory, cause)));
        return entries
          .filter((entry) => entry.endsWith(".json"))
          .map((entry) => entry.slice(0, -".json".length))
          .sort((left, right) => left.localeCompare(right));
      }),
    saveRunReport: (repositoryRoot, report) =>
      Effect.gen(function* () {
        yield* requireArtifactId("run", report.runId);
        const name = paths.join("runs", report.runId, "report.json");
        const existing = yield* read(repositoryRoot, name, (value) =>
          Exit.match(Schema.decodeUnknownExit(EvalRunReportSchema)(value), {
            onFailure: Effect.failCause,
            onSuccess: Effect.succeed
          })
        );
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(report)) {
            return yield* artifactFailure(
              "writing",
              artifactPath(repositoryRoot, name),
              new Error("run report already exists with different contents")
            );
          }
          return artifactPath(repositoryRoot, name);
        }
        yield* write(repositoryRoot, name, report, false);
        return artifactPath(repositoryRoot, name);
      }),
    loadRunReport: (repositoryRoot, runId) =>
      requireArtifactId("run", runId).pipe(
        Effect.andThen(
          read(repositoryRoot, paths.join("runs", runId, "report.json"), (value) =>
            Exit.match(Schema.decodeUnknownExit(EvalRunReportSchema)(value), {
              onFailure: Effect.failCause,
              onSuccess: Effect.succeed
            })
          )
        )
      ),
    listRunReports: (repositoryRoot) =>
      Effect.gen(function* () {
        const directory = artifactPath(repositoryRoot, "runs");
        const exists = yield* fs
          .exists(directory)
          .pipe(Effect.mapError((cause) => artifactFailure("checking", directory, cause)));
        if (!exists) return [];
        const entries = yield* fs
          .readDirectory(directory)
          .pipe(Effect.mapError((cause) => artifactFailure("listing", directory, cause)));
        const reports: string[] = [];
        for (const entry of entries) {
          const report = paths.join(directory, entry, "report.json");
          const reportExists = yield* fs
            .exists(report)
            .pipe(Effect.mapError((cause) => artifactFailure("checking", report, cause)));
          if (reportExists) reports.push(entry);
        }
        return reports.sort((left, right) => left.localeCompare(right));
      })
  });
});

export const EvalProjectArtifactsLive = Layer.effect(
  EvalProjectArtifacts,
  makeFileEvalProjectArtifacts
);
