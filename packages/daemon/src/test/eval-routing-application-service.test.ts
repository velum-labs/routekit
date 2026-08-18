import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RouterConfig } from "@velum-labs/routekit-config";
import type { PublishedRoutingActivation } from "@velum-labs/routekit-eval-contracts";
import { ControlError } from "@velum-labs/routekit-runtime/control";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect, Layer } from "effect";

import { DaemonRuntimeState } from "../daemon-runtime-state.js";
import { ActiveGateway } from "../services/active-gateway/service.js";
import { DaemonEnv } from "../services/daemon-env/service.js";
import { DaemonState } from "../services/daemon-state/service.js";
import { EvalRoutingApplicationService } from "../services/eval-routing/service.js";
import type { RunningGatewayGeneration } from "../services/gateway-generation/service.js";

function activation(evidenceDigest: string): PublishedRoutingActivation {
  const dimensions = [
    "gateway-protocol",
    "eval-routing",
    "account-pooling",
    "typescript-maintenance",
    "release-operations"
  ].map((id) => ({
    id,
    description: `Requests about ${id}`,
    includes: [`Tasks specifically involving ${id}`],
    excludes: [`Tasks unrelated to ${id}`]
  }));
  return {
    version: 2,
    generatedAt: "2026-08-18T00:00:00.000Z",
    basisDigest: "basis-1",
    evidenceDigest,
    classifierModel: "openai/classifier",
    objective: { kind: "highest-quality" },
    maximumUnknownWeight: 0.2,
    dimensions,
    candidateModels: ["openai/model-a"],
    evidence: dimensions.map((dimension) => ({
      model: "openai/model-a",
      dimensionId: dimension.id,
      suiteDigest: `suite-${dimension.id}`,
      evidenceDigest: `cell-${dimension.id}`,
      quality: {
        passRate: 0.9,
        lowerConfidenceBound: 0.8,
        sampleCount: 20
      },
      failureRate: 0.1,
      averageJudgeScore: 0.85,
      p95DurationMs: 1_000,
      unpricedCalls: 20
    }))
  };
}

test("routing activation handlers expose status and enforce compare-and-swap", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-routing-activation-"));
  const daemonEnv = Layer.succeed(
    DaemonEnv,
    DaemonEnv.of({
      home,
      configPath: join(home, "router.yaml"),
      env: {},
      packageVersion: "0.0.0-test",
      generation: 1,
      startedAt: "2026-08-18T00:00:00.000Z",
      hosted: undefined
    })
  );
  const runtimeState = new DaemonRuntimeState({
    config: {
      providers: { openai: {} },
      defaultModel: "openai/model-a",
      classifierModel: "openai/classifier"
    } as RouterConfig,
    document: "",
    revisions: { daemon: 1, config: 1, accounts: 1 }
  });
  const activeGateway = Layer.succeed(
    ActiveGateway,
    ActiveGateway.of({
      router: () =>
        ({
          modelCatalog: () => ["openai/classifier", "openai/model-a"].map((id) => ({ id }))
        }) as unknown as RunningGatewayGeneration,
      setRouter: () => undefined,
      proxy: () => undefined,
      setProxy: () => undefined,
      dataUrl: () => "http://127.0.0.1:8080",
      setDataUrl: () => undefined,
      control: () => undefined,
      setControl: () => undefined
    })
  );
  const services = Layer.mergeAll(daemonEnv, DaemonState.layer(runtimeState), activeGateway);
  const handlers = new EvalRoutingApplicationService().handlers();
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    runRouteKitEffect(effect.pipe(Effect.provide(services)) as Effect.Effect<A, E>);

  try {
    assert.deepEqual(await run(handlers["evalRouting.status"]({}, undefined as never)), {
      activation: null
    });

    const first = await run(
      handlers["evalRouting.activate"](
        {
          expectedEvidenceDigest: null,
          activation: activation("evidence-first")
        },
        undefined as never
      )
    );
    assert.equal(first.activated, true);
    assert.equal((first.activation as PublishedRoutingActivation).evidenceDigest, "evidence-first");

    await assert.rejects(
      run(
        handlers["evalRouting.activate"](
          {
            expectedEvidenceDigest: null,
            activation: activation("evidence-stale")
          },
          undefined as never
        )
      ),
      (error: unknown) => error instanceof ControlError && error.code === "conflict"
    );

    await assert.rejects(
      run(
        handlers["evalRouting.activate"](
          {
            expectedEvidenceDigest: "evidence-first",
            activation: {
              ...activation("wrong-classifier"),
              classifierModel: "openai/other-classifier"
            }
          },
          undefined as never
        )
      ),
      (error: unknown) => error instanceof ControlError && error.code === "unavailable"
    );

    const second = await run(
      handlers["evalRouting.activate"](
        {
          expectedEvidenceDigest: "evidence-first",
          activation: activation("evidence-second")
        },
        undefined as never
      )
    );
    assert.equal(
      (second.activation as PublishedRoutingActivation).evidenceDigest,
      "evidence-second"
    );
    assert.equal(
      (
        (await run(handlers["evalRouting.status"]({}, undefined as never)))
          .activation as PublishedRoutingActivation
      ).evidenceDigest,
      "evidence-second"
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
