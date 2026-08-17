import { join } from "node:path";

import {
  assertAutoRoutingDecisionV2,
  type PublishedRoutingSnapshotV2
} from "@velum-labs/routekit-eval-contracts";
import { ClassificationError, makeLanguageModelAreaClassifier } from "@velum-labs/routekit-gateway";
import { trimTrailingSlashes } from "@velum-labs/routekit-runtime";
import { executeWebRequest, type RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Cause, Clock, Crypto, Effect, Exit, FileSystem, Layer, Option, Path, Ref } from "effect";
import { HttpClient } from "effect/unstable/http";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  type ClassifierBenchmark,
  type RoutingAreaCatalogFixture,
  routingAreaCatalogFromFixture,
  runAreaClassifierQualification
} from "../eval-routing-v2/qualification.js";
import {
  DEFAULT_TESTDRIVE_FAILSAFES,
  type TestdriveAreaMatrixQualification,
  type TestdriveClassifierQualification,
  type TestdriveCompositionalRoutingDecision,
  type TestdriveFailsafes,
  type TestdriveReport,
  TestdriveWorkflowError
} from "./contracts.js";
import { runTestdriveAreaMatrix } from "./area-matrix-workflow.js";
import { makeTestdriveEgressGuardLayer, TestdriveEgressGuard } from "./egress-guard.js";
import { makeTestdriveEmbeddedRouterLayer, TestdriveEmbeddedRouter } from "./embedded-router.js";
import { makeTestdriveEvidenceLayer, TestdriveEvidence } from "./evidence.js";
import { makeTestdriveLedgerLayer, TestdriveLedger } from "./ledger.js";
import { selectClassifierQualificationModel, selectTestdriveModels } from "./pricing.js";
import { TestdriveProcess, TestdriveProcessLive } from "./process.js";
import { makeTestdriveSuiteAuthorLayer } from "./suite-author.js";
import { makeTestdriveWorkspaceLayer, TestdriveWorkspace } from "./workspace.js";

export type LiveEvalRoutingTestdriveOptions = Readonly<{
  repositoryRoot: string;
  upstreamOrigin: string;
  upstreamBearerCredential: string;
  failsafes?: Partial<TestdriveFailsafes>;
  classifierOnly?: boolean;
}>;

export const COMPOSITIONAL_TESTDRIVE_EXPECTED_CALLS = 298;
export const COMPOSITIONAL_PROBE_MINIMUM_ACTIVE_AREA_WEIGHT = 0.15;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const parseModels = (payload: unknown): readonly string[] => {
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const id = string(asRecord(entry)?.id);
    return id === undefined ? [] : [id];
  });
};

const readJsonResponse = (response: Response) =>
  Effect.promise(() =>
    response.json().then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause })
    )
  );

const requestedModelOf = (inspection: unknown): string | undefined => {
  const root = asRecord(inspection);
  return string(root?.requestedModel) ?? string(asRecord(root?.metadata)?.requested_model);
};

const runCompositionalProbe = Effect.fn("EvalRoutingTestdrive.compositionalProbe")(function* (input: {
  kind: string;
  prompt: string;
  snapshot: PublishedRoutingSnapshotV2;
  expectedAreaId?: string;
  requireComposite?: boolean;
  classifierModel: string;
  router: TestdriveEmbeddedRouter["Service"];
}) {
  const evidence = yield* TestdriveEvidence;
  const before = (yield* evidence.events).length;
  const recordOffset = input.router.recordCount();
  const observationOffset = input.router.compositionalObservationCount();
  const response = yield* executeWebRequest(
    `${trimTrailingSlashes(input.router.url)}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.router.bearerCredential}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: input.prompt }],
        max_completion_tokens: 512
      })
    }
  ).pipe(
    Effect.mapError(
      (cause) =>
        new TestdriveWorkflowError({
          phase: "compositional-routing",
          detail: `${input.kind} auto request failed`,
          cause
        })
    )
  );
  const callId = response.headers.get("x-routekit-model-call-id");
  if (!response.ok || callId === null) {
    return yield* new TestdriveWorkflowError({
      phase: "compositional-routing",
      detail: `${input.kind} auto request did not return a successful model-call id`
    });
  }
  const payload = yield* readJsonResponse(response);
  if (!payload.ok) {
    return yield* new TestdriveWorkflowError({
      phase: "compositional-routing",
      detail: `${input.kind} auto response was not JSON`,
      cause: payload.cause
    });
  }
  const records = input.router.recordsSince(recordOffset);
  if (
    records.length !== 2 ||
    records[0]?.endpoint_id !== "area-request-classifier" ||
    records[1]?.call_id !== callId
  ) {
    return yield* new TestdriveWorkflowError({
      phase: "compositional-routing",
      detail: `${input.kind} request did not record classifier and final model calls`
    });
  }
  const inspection = records[1];
  const observations = input.router.compositionalObservationsSince(observationOffset);
  const observation = observations[0];
  if (requestedModelOf(inspection) !== "auto" || observations.length !== 1) {
    return yield* new TestdriveWorkflowError({
      phase: "compositional-routing",
      detail: `${input.kind} request did not retain exactly one compositional decision`
    });
  }
  if (observation === undefined || observation.status !== "decided") {
    return yield* new TestdriveWorkflowError({
      phase: "compositional-routing",
      detail: `${input.kind} compositional routing failed closed`
    });
  }
  const decision = yield* Effect.try({
    try: () => {
      assertAutoRoutingDecisionV2(observation.decision, input.snapshot);
      return observation.decision;
    },
    catch: (cause) =>
      new TestdriveWorkflowError({
        phase: "compositional-routing",
        detail: `${input.kind} compositional decision is invalid`,
        cause
      })
  });
  const weights = new Map(
    decision.decomposition.weights.map((entry) => [entry.areaId, entry.weight] as const)
  );
  if (input.expectedAreaId !== undefined) {
    const expectedWeight = weights.get(input.expectedAreaId);
    const largestOther = Math.max(
      0,
      ...decision.decomposition.weights
        .filter((entry) => entry.areaId !== input.expectedAreaId)
        .map((entry) => entry.weight)
    );
    if (expectedWeight === undefined || expectedWeight < 0.5 || expectedWeight <= largestOther) {
      return yield* new TestdriveWorkflowError({
        phase: "compositional-routing",
        detail: `${input.kind} probe did not classify primarily into its expected area`
      });
    }
  }
  if (
    input.requireComposite === true &&
    decision.decomposition.weights.filter(
      (entry) => entry.weight >= COMPOSITIONAL_PROBE_MINIMUM_ACTIVE_AREA_WEIGHT
    ).length < 2
  ) {
    return yield* new TestdriveWorkflowError({
      phase: "compositional-routing",
      detail: `${input.kind} composite probe did not activate multiple areas`
    });
  }
  const egress = (yield* evidence.events)
    .slice(before)
    .filter((event) => event.type === "egress-reconciled");
  if (egress.length !== 2 || egress[0]?.callId === undefined || egress[1]?.callId === undefined) {
    return yield* new TestdriveWorkflowError({
      phase: "compositional-routing",
      detail: `${input.kind} auto request must produce one classifier and one inference egress`
    });
  }
  if (egress[0].model !== input.classifierModel || egress[1].model !== decision.selectedModel) {
    return yield* new TestdriveWorkflowError({
      phase: "compositional-routing",
      detail: `${input.kind} egress models do not match classifier and selected inference models`
    });
  }
  const report: TestdriveCompositionalRoutingDecision = {
    promptKind: input.kind,
    decision,
    classifierCallId: records[0].call_id,
    inferenceCallId: records[1].call_id
  };
  yield* evidence.emit({
    type: "routing-decision",
    phase: "compositional-routing",
    model: decision.selectedModel,
    callId,
    status: "passed"
  });
  return report;
});

type RunProgress = Readonly<{
  models: readonly string[];
  areaMatrixQualification?: TestdriveAreaMatrixQualification;
  compositionalRoutingDecisions: readonly TestdriveCompositionalRoutingDecision[];
  classifierQualification?: TestdriveClassifierQualification;
}>;

const runClassifierQualification = Effect.fn("EvalRoutingTestdrive.classifierV2")(
  function* (input: {
    repositoryRoot: string;
    guardOrigin: string;
    guardCredential: string;
    classifierModel: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const evidence = yield* TestdriveEvidence;
    const httpClient = yield* HttpClient.HttpClient;
    const fixtureRoot = join(
      input.repositoryRoot,
      "packages",
      "testkit",
      "src",
      "eval-routing-v2",
      "fixtures"
    );
    const [catalogText, benchmarkText] = yield* Effect.all([
      fs.readFileString(join(fixtureRoot, "routekit-area-catalog.v1.json")),
      fs.readFileString(join(fixtureRoot, "classifier-benchmark.v1.json"))
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new TestdriveWorkflowError({
            phase: "classifier-qualification",
            detail: "failed to read checked-in compositional classifier fixtures",
            cause
          })
      )
    );
    const fixtures = yield* Effect.try({
      try: () => ({
        catalog: JSON.parse(catalogText) as RoutingAreaCatalogFixture,
        benchmark: JSON.parse(benchmarkText) as ClassifierBenchmark
      }),
      catch: (cause) =>
        new TestdriveWorkflowError({
          phase: "classifier-qualification",
          detail: "checked-in compositional classifier fixtures are not valid JSON",
          cause
        })
    });
    const catalog = yield* Effect.try({
      try: () => routingAreaCatalogFromFixture(fixtures.catalog),
      catch: (cause) =>
        new TestdriveWorkflowError({
          phase: "classifier-qualification",
          detail: "checked-in compositional area catalog is invalid",
          cause
        })
    });
    const classifier = makeLanguageModelAreaClassifier({
      model: input.classifierModel,
      complete: (body, signal) =>
        executeWebRequest(`${input.guardOrigin}/v1/chat/completions`, {
          method: "POST",
          signal,
          headers: {
            authorization: `Bearer ${input.guardCredential}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(body)
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError(
            (cause) =>
              new ClassificationError({
                message: "guarded classifier request failed",
                cause
              })
          )
        )
    });
    yield* evidence.emit({
      type: "phase-started",
      phase: "classifier-qualification",
      model: input.classifierModel,
      status: "running"
    });
    const report = yield* runAreaClassifierQualification({
      catalog,
      benchmark: fixtures.benchmark,
      classifier
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TestdriveWorkflowError({
            phase: "classifier-qualification",
            detail: "compositional classifier qualification configuration is invalid",
            cause
          })
      )
    );
    const summary = yield* evidence.writeClassifierQualification(report);
    yield* evidence.emit({
      type: "phase-finished",
      phase: "classifier-qualification",
      model: input.classifierModel,
      status: report.passed ? "passed" : "failed",
      sampleCount: report.expectedCaseCount,
      passedCount: report.cases.filter((entry) => entry.passed).length,
      failedCount: report.cases.filter((entry) => !entry.passed).length
    });
    return summary;
  }
);

const runWithWorkspace = (
  options: LiveEvalRoutingTestdriveOptions,
  input: {
    runId: string;
    startedAt: string;
    artifactDirectory: string;
    revision: string;
    failsafes: TestdriveFailsafes;
    guardCredential: string;
  },
  progress: Ref.Ref<RunProgress>
) =>
  Effect.gen(function* () {
    const workspace = yield* TestdriveWorkspace;
    const guardLayer = makeTestdriveEgressGuardLayer({
      upstreamOrigin: options.upstreamOrigin,
      upstreamBearerCredential: options.upstreamBearerCredential,
      inboundBearerCredential: input.guardCredential,
      failsafes: input.failsafes
    });
    return yield* Effect.gen(function* () {
      const paths = yield* Path.Path;
      const guard = yield* TestdriveEgressGuard;
      const evidence = yield* TestdriveEvidence;
      const ledger = yield* TestdriveLedger;
      const catalogResponse = yield* executeWebRequest(`${guard.origin}/v1/models`, {
        headers: { authorization: `Bearer ${input.guardCredential}` }
      });
      const catalog = yield* readJsonResponse(catalogResponse);
      if (!catalog.ok) {
        return yield* new TestdriveWorkflowError({
          phase: "model-discovery",
          detail: "Orbit model catalog was not JSON",
          cause: catalog.cause
        });
      }
      const discoveredModels = parseModels(catalog.value);
      const selected = yield* Effect.try({
        try: () => (options.classifierOnly ? undefined : selectTestdriveModels(discoveredModels)),
        catch: (cause) =>
          new TestdriveWorkflowError({
            phase: "model-discovery",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause
          })
      });
      const classifierModel = yield* Effect.try({
        try: () => selected?.classifier ?? selectClassifierQualificationModel(discoveredModels),
        catch: (cause) =>
          new TestdriveWorkflowError({
            phase: "model-discovery",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause
          })
      });
      yield* Ref.update(progress, (current) => ({
        ...current,
        models:
          selected === undefined
            ? [classifierModel]
            : [...selected.candidates, selected.author, selected.judge, selected.classifier]
      }));
      const classifierQualification = yield* runClassifierQualification({
        repositoryRoot: workspace.checkoutRoot,
        guardOrigin: guard.origin,
        guardCredential: input.guardCredential,
        classifierModel
      });
      yield* Ref.update(progress, (current) => ({
        ...current,
        classifierQualification
      }));
      if (!classifierQualification.passed) {
        return yield* new TestdriveWorkflowError({
          phase: "classifier-qualification",
          detail: "compositional classifier did not meet the reviewed benchmark thresholds"
        });
      }
      if (options.classifierOnly) {
        const finalLedger = yield* ledger.snapshot;
        if (finalLedger.activeReservations !== 0 || finalLedger.unknownMeasurements !== 0) {
          return yield* new TestdriveWorkflowError({
            phase: "failsafe",
            detail: "egress ledger finished with unresolved billed measurements"
          });
        }
        return;
      }
      if (selected === undefined) {
        return yield* new TestdriveWorkflowError({
          phase: "model-discovery",
          detail: "full testdrive model selection was not retained"
        });
      }
      const routerLayer = makeTestdriveEmbeddedRouterLayer({
        stateHome: workspace.stateHome,
        guardOrigin: guard.origin,
        guardBearerCredential: input.guardCredential,
        defaultModel: selected.author,
        classifierModel: selected.classifier,
        compositionalRouting: {
          maximumUnknownWeight: 0.35,
          objective: { kind: "highest-quality" }
        }
      });
      return yield* Effect.gen(function* () {
        const router = yield* TestdriveEmbeddedRouter;
        const suiteAuthorLayer = makeTestdriveSuiteAuthorLayer({
          gatewayOrigin: router.url,
          gatewayBearerCredential: router.bearerCredential,
          model: selected.author
        });
        return yield* Effect.gen(function* () {
          const matrix = yield* runTestdriveAreaMatrix({
            repositoryRoot: workspace.profileRepository,
            gatewayUrl: router.url,
            bearerCredential: router.bearerCredential,
            snapshotRoot: paths.join(workspace.stateHome, "eval"),
            candidateModels: selected.candidates,
            judgeModel: selected.judge
          });
          yield* Ref.update(progress, (current) => ({
            ...current,
            areaMatrixQualification: matrix.qualification
          }));
          for (const probe of matrix.probes) {
            const decision = yield* runCompositionalProbe({
              kind: probe.areaId,
              prompt: probe.prompt,
              snapshot: matrix.snapshot,
              expectedAreaId: probe.areaId,
              classifierModel: selected.classifier,
              router
            });
            yield* Ref.update(progress, (current) => ({
              ...current,
              compositionalRoutingDecisions: [
                ...current.compositionalRoutingDecisions,
                decision
              ]
            }));
          }
          for (const probe of matrix.compositeProbes) {
            const decision = yield* runCompositionalProbe({
              kind: probe.caseId,
              prompt: probe.prompt,
              snapshot: matrix.snapshot,
              requireComposite: true,
              classifierModel: selected.classifier,
              router
            });
            yield* Ref.update(progress, (current) => ({
              ...current,
              compositionalRoutingDecisions: [
                ...current.compositionalRoutingDecisions,
                decision
              ]
            }));
          }
          yield* router.close;
          const finalLedger = yield* ledger.snapshot;
          if (finalLedger.activeReservations !== 0 || finalLedger.unknownMeasurements !== 0) {
            return yield* new TestdriveWorkflowError({
              phase: "failsafe",
              detail: "egress ledger finished with unresolved billed measurements"
            });
          }
        }).pipe(Effect.provide(suiteAuthorLayer));
      }).pipe(Effect.provide(routerLayer));
    }).pipe(Effect.provide(guardLayer));
  });

export function runLiveEvalRoutingTestdrive(
  options: LiveEvalRoutingTestdriveOptions
): Effect.Effect<TestdriveReport, unknown, RouteKitPlatform | ChildProcessSpawner> {
  const failsafes: TestdriveFailsafes = {
    ...DEFAULT_TESTDRIVE_FAILSAFES,
    ...options.failsafes
  };
  return Effect.scoped(
    Effect.gen(function* () {
      if (process.env.ROUTEKIT_LIVE_E2E !== "1") {
        return yield* new TestdriveWorkflowError({
          phase: "preflight",
          detail: "set ROUTEKIT_LIVE_E2E=1 to authorize billed model calls"
        });
      }
      if (!options.classifierOnly && failsafes.maxEgressCalls < COMPOSITIONAL_TESTDRIVE_EXPECTED_CALLS) {
        return yield* new TestdriveWorkflowError({
          phase: "preflight",
          detail: `full compositional qualification requires at least ${String(
            COMPOSITIONAL_TESTDRIVE_EXPECTED_CALLS
          )} guarded egress calls`
        });
      }
      const processService = yield* TestdriveProcess;
      const dirty = (yield* processService.run("git", ["status", "--porcelain"], {
        cwd: options.repositoryRoot,
        timeoutMs: 30_000
      })).stdout.trim();
      if (dirty.length > 0) {
        return yield* new TestdriveWorkflowError({
          phase: "preflight",
          detail: "live eval-routing testdrive requires a clean committed worktree"
        });
      }
      const revision = (yield* processService.run("git", ["rev-parse", "HEAD"], {
        cwd: options.repositoryRoot,
        timeoutMs: 30_000
      })).stdout.trim();
      const now = yield* Clock.currentTimeMillis;
      const crypto = yield* Crypto.Crypto;
      const guardCredentialPart1 = yield* crypto.randomUUIDv4;
      const guardCredentialPart2 = yield* crypto.randomUUIDv4;
      const guardCredential = `${guardCredentialPart1}${guardCredentialPart2}`;
      const startedAt = new Date(now).toISOString();
      const runId = `${startedAt.replace(/[-:.]/gu, "")}-${revision.slice(0, 12)}`;
      const artifactDirectory = join(
        options.repositoryRoot,
        ".artifacts",
        options.classifierOnly ? "eval-routing-classifier" : "eval-routing",
        runId
      );
      const ledgerLayer = makeTestdriveLedgerLayer(failsafes);
      const evidenceLayer = makeTestdriveEvidenceLayer({
        artifactDirectory,
        failsafes,
        revision,
        runId
      }).pipe(Layer.provide(ledgerLayer));
      const stateLayer = Layer.merge(ledgerLayer, evidenceLayer);
      return yield* Effect.gen(function* () {
        const evidence = yield* TestdriveEvidence;
        const progress = yield* Ref.make<RunProgress>({
          models: [],
          compositionalRoutingDecisions: []
        });
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* evidence.emit({
              type: "run-started",
              phase: "setup",
              status: "running"
            });
            const resourceRun = runWithWorkspace(
              options,
              {
                runId,
                startedAt,
                artifactDirectory,
                revision,
                failsafes,
                guardCredential
              },
              progress
            ).pipe(
              Effect.provide(
                makeTestdriveWorkspaceLayer({ repositoryRoot: options.repositoryRoot })
              )
            );
            const boundedRun = Effect.scoped(resourceRun).pipe(
              Effect.timeoutOption(failsafes.maxWallTimeMs),
              Effect.flatMap((result) =>
                Option.isSome(result)
                  ? Effect.void
                  : Effect.fail(
                      new TestdriveWorkflowError({
                        phase: "failsafe",
                        detail: "live eval-routing testdrive exceeded its wall-time failsafe"
                      })
                    )
              )
            );
            const exit = yield* restore(boundedRun).pipe(Effect.exit);
            const completed = yield* Ref.get(progress);
            if (Exit.isSuccess(exit)) {
              yield* evidence.emit({
                type: "run-finished",
                phase: "complete",
                status: "passed"
              });
            } else {
              const failure = Cause.squash(exit.cause);
              yield* evidence
                .emit({
                  type: "failure",
                  phase: "testdrive",
                  status: "failed",
                  failureCode: Cause.hasInterruptsOnly(exit.cause)
                    ? "interrupted"
                    : failure instanceof TestdriveWorkflowError
                      ? failure.phase
                      : "unexpected-failure"
                })
                .pipe(Effect.ignore);
            }
            const reportExit = yield* evidence
              .writeReport({
                startedAt,
                status: Exit.isSuccess(exit) ? "passed" : "failed",
                models: completed.models,
                ...(completed.areaMatrixQualification === undefined
                  ? {}
                  : { areaMatrixQualification: completed.areaMatrixQualification }),
                compositionalRoutingDecisions: completed.compositionalRoutingDecisions,
                ...(completed.classifierQualification === undefined
                  ? {}
                  : { classifierQualification: completed.classifierQualification })
              })
              .pipe(Effect.exit);
            if (Exit.isFailure(exit)) {
              return yield* Effect.failCause(exit.cause);
            }
            if (Exit.isFailure(reportExit)) {
              return yield* Effect.failCause(reportExit.cause);
            }
            return reportExit.value;
          })
        );
      }).pipe(Effect.provide(stateLayer));
    }).pipe(Effect.provide(TestdriveProcessLive))
  );
}
