import { join } from "node:path";

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
  type TestdriveClassifierQualification,
  type TestdriveFailsafes,
  type TestdriveProfileReport,
  type TestdriveReport,
  type TestdriveRoutingDecision,
  TestdriveWorkflowError
} from "./contracts.js";
import { makeTestdriveEgressGuardLayer, TestdriveEgressGuard } from "./egress-guard.js";
import { makeTestdriveEmbeddedRouterLayer, TestdriveEmbeddedRouter } from "./embedded-router.js";
import { makeTestdriveEvidenceLayer, TestdriveEvidence } from "./evidence.js";
import { makeTestdriveLedgerLayer, TestdriveLedger } from "./ledger.js";
import { selectTestdriveModels } from "./pricing.js";
import { TestdriveProcess, TestdriveProcessLive } from "./process.js";
import {
  makeTestdriveProfileDiscoveryLayer,
  TestdriveProfileDiscovery
} from "./profile-discovery.js";
import {
  makeTestdriveProfileDriverLayer,
  TestdriveProfileDriver,
  type TestdriveProfileInput
} from "./profile-workflow.js";
import { makeTestdriveSuiteAuthorLayer } from "./suite-author.js";
import { makeTestdriveWorkspaceLayer, TestdriveWorkspace } from "./workspace.js";

export type LiveEvalRoutingTestdriveOptions = Readonly<{
  repositoryRoot: string;
  upstreamOrigin: string;
  upstreamBearerCredential: string;
  failsafes?: Partial<TestdriveFailsafes>;
  classifierOnly?: boolean;
}>;

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

const autoRoutingOf = (inspection: unknown) => {
  const root = asRecord(inspection);
  const metadata = asRecord(root?.metadata);
  const attribution = asRecord(metadata?.attribution);
  const routing = asRecord(root?.autoRouting) ?? asRecord(attribution?.auto_routing);
  const profileId = string(routing?.profileId) ?? string(routing?.profile_id);
  const selectedModel = string(routing?.selectedModel) ?? string(routing?.selected_model);
  const evidenceDigest = string(routing?.evidenceDigest) ?? string(routing?.evidence_digest);
  const scores = Array.isArray(routing?.scores)
    ? routing.scores.flatMap((value) => {
        const score = asRecord(value);
        const scoredProfile = string(score?.profileId) ?? string(score?.profile_id);
        const probability =
          typeof score?.probability === "number" && Number.isFinite(score.probability)
            ? score.probability
            : undefined;
        return scoredProfile === undefined || probability === undefined
          ? []
          : [{ profileId: scoredProfile, probability }];
      })
    : [];
  return profileId === undefined ||
    selectedModel === undefined ||
    evidenceDigest === undefined ||
    scores.length === 0
    ? undefined
    : { profileId, selectedModel, evidenceDigest, scores };
};

const requestedModelOf = (inspection: unknown): string | undefined => {
  const root = asRecord(inspection);
  return string(root?.requestedModel) ?? string(asRecord(root?.metadata)?.requested_model);
};

const runAutoProbe = Effect.fn("EvalRoutingTestdrive.autoProbe")(function* (input: {
  kind: string;
  prompt: string;
  expectedProfile: TestdriveProfileReport;
  classifierModel: string;
  router: TestdriveEmbeddedRouter["Service"];
}) {
  const evidence = yield* TestdriveEvidence;
  const before = (yield* evidence.events).length;
  const recordOffset = input.router.recordCount();
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
          phase: "auto-routing",
          detail: `${input.kind} auto request failed`,
          cause
        })
    )
  );
  const callId = response.headers.get("x-routekit-model-call-id");
  if (!response.ok || callId === null) {
    return yield* new TestdriveWorkflowError({
      phase: "auto-routing",
      detail: `${input.kind} auto request did not return a successful model-call id`
    });
  }
  const payload = yield* readJsonResponse(response);
  if (!payload.ok) {
    return yield* new TestdriveWorkflowError({
      phase: "auto-routing",
      detail: `${input.kind} auto response was not JSON`,
      cause: payload.cause
    });
  }
  const records = input.router.recordsSince(recordOffset);
  if (
    records.length !== 2 ||
    records[0]?.endpoint_id !== "request-classifier" ||
    records[1]?.call_id !== callId
  ) {
    return yield* new TestdriveWorkflowError({
      phase: "auto-routing",
      detail: `${input.kind} request did not record classifier and final model calls`
    });
  }
  const inspection = records[1];
  const routing = autoRoutingOf(inspection);
  if (
    requestedModelOf(inspection) !== "auto" ||
    routing === undefined ||
    routing.profileId !== input.expectedProfile.profileId
  ) {
    return yield* new TestdriveWorkflowError({
      phase: "auto-routing",
      detail: `${input.kind} request selected ${routing?.profileId ?? "no profile"}`
    });
  }
  const scoreTotal = routing.scores.reduce((sum, score) => sum + score.probability, 0);
  if (
    routing.evidenceDigest !== input.expectedProfile.evidenceDigest ||
    ![input.expectedProfile.selectedModel, ...input.expectedProfile.fallbackModels].includes(
      routing.selectedModel
    ) ||
    new Set(routing.scores.map((score) => score.profileId)).size !== 2 ||
    routing.scores.some((score) => score.probability < 0 || score.probability > 1) ||
    Math.abs(scoreTotal - 1) > 1e-9
  ) {
    return yield* new TestdriveWorkflowError({
      phase: "auto-routing",
      detail: `${input.kind} auto-routing provenance is incomplete or inconsistent`
    });
  }
  const egress = (yield* evidence.events)
    .slice(before)
    .filter((event) => event.type === "egress-reconciled");
  if (egress.length !== 2 || egress[0]?.callId === undefined || egress[1]?.callId === undefined) {
    return yield* new TestdriveWorkflowError({
      phase: "auto-routing",
      detail: `${input.kind} auto request must produce one classifier and one inference egress`
    });
  }
  if (egress[0].model !== input.classifierModel || egress[1].model !== routing.selectedModel) {
    return yield* new TestdriveWorkflowError({
      phase: "auto-routing",
      detail: `${input.kind} egress models do not match classifier and selected inference models`
    });
  }
  const decision: TestdriveRoutingDecision = {
    promptKind: input.kind,
    profileId: routing.profileId,
    selectedModel: routing.selectedModel,
    evidenceDigest: routing.evidenceDigest,
    scores: routing.scores,
    classifierCallId: records[0].call_id,
    inferenceCallId: records[1].call_id
  };
  yield* evidence.emit({
    type: "routing-decision",
    phase: "auto-routing",
    profileId: decision.profileId,
    model: decision.selectedModel,
    callId,
    status: "passed"
  });
  return decision;
});

type RunProgress = Readonly<{
  models: readonly string[];
  profiles: readonly TestdriveProfileReport[];
  routingDecisions: readonly TestdriveRoutingDecision[];
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
      const selected = yield* Effect.try({
        try: () => selectTestdriveModels(parseModels(catalog.value)),
        catch: (cause) =>
          new TestdriveWorkflowError({
            phase: "model-discovery",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause
          })
      });
      yield* Ref.update(progress, (current) => ({
        ...current,
        models: options.classifierOnly
          ? [selected.classifier]
          : [...selected.slates.flat(), selected.author, selected.judge, selected.classifier]
      }));
      const classifierQualification = yield* runClassifierQualification({
        repositoryRoot: workspace.checkoutRoot,
        guardOrigin: guard.origin,
        guardCredential: input.guardCredential,
        classifierModel: selected.classifier
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
      const routerLayer = makeTestdriveEmbeddedRouterLayer({
        stateHome: workspace.stateHome,
        guardOrigin: guard.origin,
        guardBearerCredential: input.guardCredential,
        defaultModel: selected.author,
        classifierModel: selected.classifier
      });
      return yield* Effect.gen(function* () {
        const router = yield* TestdriveEmbeddedRouter;
        const discoveryLayer = makeTestdriveProfileDiscoveryLayer({
          gatewayOrigin: router.url,
          gatewayBearerCredential: router.bearerCredential,
          model: selected.author
        });
        const discoveredProfiles = yield* Effect.gen(function* () {
          return yield* (yield* TestdriveProfileDiscovery).discover(workspace.checkoutRoot);
        }).pipe(Effect.provide(discoveryLayer));
        const suiteAuthorLayer = makeTestdriveSuiteAuthorLayer({
          gatewayOrigin: router.url,
          gatewayBearerCredential: router.bearerCredential,
          model: selected.author
        });
        const profileDriverLayer = makeTestdriveProfileDriverLayer({
          gatewayUrl: router.url,
          bearerCredential: router.bearerCredential,
          snapshotRoot: paths.join(workspace.stateHome, "eval")
        });
        return yield* Effect.gen(function* () {
          const driver = yield* TestdriveProfileDriver;
          const first = yield* driver.drive({
            profile: discoveredProfiles[0],
            candidates: selected.slates[0],
            repositoryRoot: workspace.profileRepository,
            judgeModel: selected.judge
          } satisfies TestdriveProfileInput);
          yield* Ref.update(progress, (current) => ({
            ...current,
            profiles: [...current.profiles, first]
          }));
          const second = yield* driver.drive({
            profile: discoveredProfiles[1],
            candidates: selected.slates[1],
            repositoryRoot: workspace.profileRepository,
            judgeModel: selected.judge
          } satisfies TestdriveProfileInput);
          yield* Ref.update(progress, (current) => ({
            ...current,
            profiles: [...current.profiles, second]
          }));
          const firstDecision = yield* runAutoProbe({
            kind: discoveredProfiles[0].id,
            prompt: discoveredProfiles[0].probe,
            expectedProfile: first,
            classifierModel: selected.classifier,
            router
          });
          yield* Ref.update(progress, (current) => ({
            ...current,
            routingDecisions: [...current.routingDecisions, firstDecision]
          }));
          const secondDecision = yield* runAutoProbe({
            kind: discoveredProfiles[1].id,
            prompt: discoveredProfiles[1].probe,
            expectedProfile: second,
            classifierModel: selected.classifier,
            router
          });
          yield* Ref.update(progress, (current) => ({
            ...current,
            routingDecisions: [...current.routingDecisions, secondDecision]
          }));
          yield* router.close;
          const finalLedger = yield* ledger.snapshot;
          if (finalLedger.activeReservations !== 0 || finalLedger.unknownMeasurements !== 0) {
            return yield* new TestdriveWorkflowError({
              phase: "failsafe",
              detail: "egress ledger finished with unresolved billed measurements"
            });
          }
        }).pipe(Effect.provide(profileDriverLayer.pipe(Layer.provide(suiteAuthorLayer))));
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
        options.classifierOnly ? "eval-routing-v2" : "eval-routing-testdrive",
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
          profiles: [],
          routingDecisions: []
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
                profiles: completed.profiles,
                routingDecisions: completed.routingDecisions,
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
