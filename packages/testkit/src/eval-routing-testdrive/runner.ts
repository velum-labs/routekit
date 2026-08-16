import { join } from "node:path";

import { makeRouteKitEvalSetupLayer } from "@velum-labs/routekit-eval-service";
import { trimTrailingSlashes } from "@velum-labs/routekit-runtime";
import { executeWebRequest, type RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Clock, Crypto, Effect, Layer, Option, Path } from "effect";
import { HttpClient } from "effect/unstable/http";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { stringify as stringifyYaml } from "yaml";

import {
  DEFAULT_TESTDRIVE_FAILSAFES,
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
import { makeTestdriveOperatorAgentLayer, TestdriveOperatorAgent } from "./operator-agent.js";
import { selectDisjointPricedModels } from "./pricing.js";
import { TestdriveProcess, TestdriveProcessLive } from "./process.js";
import {
  makeTestdriveProfileDiscoveryLayer,
  TestdriveProfileDiscovery
} from "./profile-discovery.js";
import {
  TestdriveProfileDriver,
  TestdriveProfileDriverLive,
  type TestdriveProfileInput
} from "./profile-workflow.js";
import { makeTestdriveWorkspaceLayer, TestdriveWorkspace } from "./workspace.js";

export type LiveEvalRoutingTestdriveOptions = Readonly<{
  repositoryRoot: string;
  upstreamOrigin: string;
  upstreamBearerCredential: string;
  failsafes?: Partial<TestdriveFailsafes>;
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

const runWithWorkspace = (
  options: LiveEvalRoutingTestdriveOptions,
  input: {
    runId: string;
    startedAt: string;
    artifactDirectory: string;
    revision: string;
    failsafes: TestdriveFailsafes;
    guardCredential: string;
  }
) =>
  Effect.gen(function* () {
    const workspace = yield* TestdriveWorkspace;
    const ledgerLayer = makeTestdriveLedgerLayer(input.failsafes);
    const evidenceLayer = makeTestdriveEvidenceLayer({
      artifactDirectory: input.artifactDirectory,
      failsafes: input.failsafes,
      revision: input.revision,
      runId: input.runId
    }).pipe(Layer.provide(ledgerLayer));
    const stateLayer = Layer.merge(ledgerLayer, evidenceLayer);
    const guardLayer = makeTestdriveEgressGuardLayer({
      upstreamOrigin: options.upstreamOrigin,
      upstreamBearerCredential: options.upstreamBearerCredential,
      inboundBearerCredential: input.guardCredential,
      failsafes: input.failsafes
    }).pipe(Layer.provide(stateLayer));
    const liveLayer = Layer.merge(stateLayer, guardLayer);
    return yield* Effect.gen(function* () {
      const paths = yield* Path.Path;
      const guard = yield* TestdriveEgressGuard;
      const evidence = yield* TestdriveEvidence;
      const ledger = yield* TestdriveLedger;
      yield* evidence.emit({ type: "run-started", phase: "setup", status: "running" });
      const execution = Effect.gen(function* () {
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
          try: () => selectDisjointPricedModels(parseModels(catalog.value)),
          catch: (cause) =>
            new TestdriveWorkflowError({
              phase: "model-discovery",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause
            })
        });
        const routerLayer = makeTestdriveEmbeddedRouterLayer({
          stateHome: workspace.stateHome,
          guardOrigin: guard.origin,
          guardBearerCredential: input.guardCredential,
          defaultModel: selected.author,
          classifierModel: selected.classifier
        });
        return yield* Effect.gen(function* () {
          const router = yield* TestdriveEmbeddedRouter;
          const operatorLayer = makeTestdriveOperatorAgentLayer({
            gatewayOrigin: router.url,
            gatewayBearerCredential: router.bearerCredential,
            model: selected.author
          });
          const discoveryLayer = makeTestdriveProfileDiscoveryLayer({
            gatewayOrigin: router.url,
            gatewayBearerCredential: router.bearerCredential,
            model: selected.author
          });
          const discoveredProfiles = yield* Effect.gen(function* () {
            return yield* (yield* TestdriveProfileDiscovery).discover(workspace.checkoutRoot);
          }).pipe(Effect.provide(discoveryLayer));
          const setupLayer = makeRouteKitEvalSetupLayer({
            gatewayUrl: router.url,
            snapshotRoot: paths.join(workspace.stateHome, "eval"),
            authorHarness: "pi",
            authorModel: selected.author,
            judgeModel: selected.judge,
            bearerCredential: router.bearerCredential
          });
          const profileProgram = Effect.gen(function* () {
            const driver = yield* TestdriveProfileDriver;
            const first = yield* driver.drive({
              profileId: discoveredProfiles[0].id,
              description: discoveredProfiles[0].description,
              brief: discoveredProfiles[0].brief,
              candidates: selected.slates[0],
              repositoryRoot: workspace.profileRepository
            } satisfies TestdriveProfileInput);
            const second = yield* driver.drive({
              profileId: discoveredProfiles[1].id,
              description: discoveredProfiles[1].description,
              brief: discoveredProfiles[1].brief,
              candidates: selected.slates[1],
              repositoryRoot: workspace.profileRepository
            } satisfies TestdriveProfileInput);
            return [first, second] as const;
          }).pipe(
            Effect.provide(
              TestdriveProfileDriverLive.pipe(Layer.provide(Layer.merge(operatorLayer, setupLayer)))
            )
          );
          const profiles = yield* profileProgram;
          const decisions = yield* Effect.all(
            [
              runAutoProbe({
                kind: discoveredProfiles[0].id,
                prompt: discoveredProfiles[0].probe,
                expectedProfile: profiles[0],
                classifierModel: selected.classifier,
                router
              }),
              runAutoProbe({
                kind: discoveredProfiles[1].id,
                prompt: discoveredProfiles[1].probe,
                expectedProfile: profiles[1],
                classifierModel: selected.classifier,
                router
              })
            ],
            { concurrency: 1 }
          );
          yield* router.close;
          const finalLedger = yield* ledger.snapshot;
          if (finalLedger.activeReservations !== 0 || finalLedger.unknownMeasurements !== 0) {
            return yield* new TestdriveWorkflowError({
              phase: "failsafe",
              detail: "egress ledger finished with unresolved billed measurements"
            });
          }
          yield* evidence.emit({ type: "run-finished", phase: "complete", status: "passed" });
          return yield* evidence.writeReport({
            startedAt: input.startedAt,
            status: "passed",
            models: [
              ...selected.slates.flat(),
              selected.author,
              selected.judge,
              selected.classifier
            ],
            profiles,
            routingDecisions: decisions
          });
        }).pipe(Effect.provide(routerLayer));
      });
      return yield* execution.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* evidence
              .emit({
                type: "failure",
                phase: "testdrive",
                status: "failed",
                failureCode:
                  error instanceof TestdriveWorkflowError ? error.phase : "unexpected-failure"
              })
              .pipe(Effect.ignore);
            yield* evidence
              .writeReport({
                startedAt: input.startedAt,
                status: "failed",
                models: [],
                profiles: [],
                routingDecisions: []
              })
              .pipe(Effect.ignore);
            return yield* error;
          })
        )
      );
    }).pipe(Effect.provide(liveLayer));
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
        "eval-routing-testdrive",
        runId
      );
      const run = runWithWorkspace(options, {
        runId,
        startedAt,
        artifactDirectory,
        revision,
        failsafes,
        guardCredential
      }).pipe(
        Effect.provide(makeTestdriveWorkspaceLayer({ repositoryRoot: options.repositoryRoot }))
      );
      return yield* run.pipe(
        Effect.timeoutOption(failsafes.maxWallTimeMs),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.fail(
                new TestdriveWorkflowError({
                  phase: "failsafe",
                  detail: "live eval-routing testdrive exceeded its wall-time failsafe"
                })
              )
        )
      );
    }).pipe(Effect.provide(TestdriveProcessLive))
  );
}
