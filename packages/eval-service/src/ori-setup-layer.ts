import path from "node:path";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { EvalRunManifest } from "@velum-labs/routekit-eval-contracts";
import {
  evalExecutionModels,
  makeEvalEngineLayer,
  makeOriRouteKitGatewayBridge,
  validateEvals
} from "@velum-labs/routekit-eval-engine";
import { createEvalAuthoring } from "@velum-labs/routekit-eval-engine/authoring";
import {
  EvalSetup,
  EvalSetupLive,
  EvalSetupRunner,
  EvalSetupRunnerError,
  OriEvalAuthoring,
  type OriEvalResult
} from "@velum-labs/routekit-eval-setup";
import { Effect, FileSystem, Layer, Schema } from "effect";
import type { RouteKitEvalSetupLayerOptions } from "./layer-options.js";
import type { CompletedOriLibraryResult } from "./ori-artifact-promotion.js";
import {
  publishOriEvalPolicyHandoff,
  selectLatestSuccessfulOriEvalRun
} from "./ori-artifact-promotion.js";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const scratchOf = (result: OriEvalResult): string | undefined => {
  const state = asRecord(result.state);
  return (
    (typeof result.scratchWorkspace === "string" ? result.scratchWorkspace : undefined) ??
    (typeof state?.scratchWorkspace === "string" ? state.scratchWorkspace : undefined)
  );
};

const completedResult = (result: OriEvalResult): CompletedOriLibraryResult => {
  const evalRuns = result.evalRuns;
  if (!Array.isArray(evalRuns)) {
    throw new Error("completed Ori result does not include structured evalRuns");
  }
  return {
    ok: result.ok,
    status: typeof result.status === "string" ? result.status : undefined,
    evalRuns: evalRuns as CompletedOriLibraryResult["evalRuns"],
    ...(scratchOf(result) === undefined ? {} : { scratchWorkspace: scratchOf(result) }),
    ...(asRecord(result.state) === undefined
      ? {}
      : {
          state: {
            scratchWorkspace: scratchOf(result),
            status: typeof result.status === "string" ? result.status : undefined
          }
        })
  };
};

const estimateFromOri = (
  result: OriEvalResult,
  mode: "full" | "pilot" | "save-only"
): Effect.Effect<
  { readonly callCount: number; readonly pricingKnown: false },
  EvalSetupRunnerError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const scratch = scratchOf(result);
    if (scratch === undefined) {
      return yield* new EvalSetupRunnerError({
        operation: "estimate",
        detail: "prospective estimate requires an authored scratch workspace"
      });
    }
    const fs = yield* FileSystem.FileSystem;
    const manifests = yield* fs.glob("**/routekit.eval-manifest.json", { root: scratch });
    if (manifests.length !== 1 || manifests[0] === undefined) {
      return yield* new EvalSetupRunnerError({
        operation: "estimate",
        detail: "prospective estimate requires exactly one routekit.eval-manifest.json"
      });
    }
    const raw = yield* fs.readFileString(manifests[0]);
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new EvalSetupRunnerError({
          operation: "estimate",
          detail: "eval manifest is not JSON",
          cause
        })
    });
    const manifest = yield* Schema.decodeUnknownEffect(EvalRunManifest)(json).pipe(
      Effect.mapError(
        (cause) =>
          new EvalSetupRunnerError({
            operation: "estimate",
            detail: `eval manifest is invalid: ${String(cause)}`,
            cause
          })
      )
    );
    if (manifest.candidateModels.length < 2 || manifest.caseCount < 1) {
      return yield* new EvalSetupRunnerError({
        operation: "estimate",
        detail: "eval manifest requires at least two candidates and one case"
      });
    }
    for (const model of [...manifest.candidateModels, manifest.judgeModel]) {
      if (!explicitModel(model)) {
        return yield* new EvalSetupRunnerError({
          operation: "estimate",
          detail: `eval manifest contains invalid model ${JSON.stringify(model)}`
        });
      }
    }
    const caseCount =
      mode === "save-only"
        ? 0
        : mode === "pilot"
          ? Math.min(3, manifest.caseCount)
          : manifest.caseCount;
    return {
      callCount: caseCount * manifest.candidateModels.length * 2,
      pricingKnown: false as const
    };
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof EvalSetupRunnerError
        ? cause
        : new EvalSetupRunnerError({
            operation: "estimate",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause
          })
    )
  );

const explicitModel = (model: string): boolean => {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    !["auto", "router", "default"].includes(normalized) &&
    /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/u.test(model)
  );
};

export const makeOriEvalSetupLayer = (
  options: RouteKitEvalSetupLayerOptions
): Layer.Layer<EvalSetup> => {
  const authoring = OriEvalAuthoring.layer({
    withAuthoring: (input, use) =>
      Effect.scoped(
        Effect.gen(function* () {
          const stateRoot = path.join(
            input.repositoryRoot,
            ".routekit",
            "eval-setup",
            input.profileId
          );
          const token = options.bearerCredential?.trim();
          const authorHarness = options.authorHarness ?? "claude";
          const authorModel = options.authorModel ?? "claude-code/claude-sonnet-5";
          const judgeModel = options.judgeModel ?? "claude-code/claude-sonnet-5";
          const withHostedPrepare = (
            api: ReturnType<typeof createEvalAuthoring>
          ): Parameters<typeof use>[0] => ({
            prepare: (input) =>
              api.prepare({
                ...input,
                harness: authorHarness,
                model: authorModel,
                judgeModel
              }),
            run: (input) => api.run(input),
            answer: (input) => api.answer(input),
            status: (input) => api.status(input)
          });
          if (token === undefined || token.length === 0) {
            return yield* Effect.tryPromise({
              try: () =>
                use(
                  withHostedPrepare(
                    createEvalAuthoring({
                      environment: {
                        ORI_TELEMETRY: "0",
                        PATH: process.env.PATH,
                        ...(process.env.ORI_CLAUDE_BIN === undefined ||
                        process.env.ORI_CLAUDE_BIN.trim() === ""
                          ? {}
                          : { ORI_CLAUDE_BIN: process.env.ORI_CLAUDE_BIN })
                      },
                      stateRoot
                    })
                  )
                ),
              catch: (cause) =>
                new EvalSetupRunnerError({
                  operation: "call Ori authoring",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause
                })
            });
          }
          const bridge = yield* makeOriRouteKitGatewayBridge({
            allowModel: options.allowModel ?? explicitModel,
            attribution: { runId: input.profileId },
            authorModel,
            bearerCredential: token,
            gatewayOrigin: options.gatewayUrl,
            judgeModel
          }).pipe(
            Effect.mapError(
              (cause) =>
                new EvalSetupRunnerError({
                  operation: "start Ori gateway bridge",
                  detail: cause.message,
                  cause
                })
            )
          );
          return yield* Effect.tryPromise({
            try: () =>
              use(
                withHostedPrepare(
                  createEvalAuthoring({
                    environment: {
                      OPENROUTER_API_KEY: bridge.childCredential,
                      ORI_EVAL_API_BASE_URL: bridge.origin,
                      ORI_TELEMETRY: "0",
                      PATH: process.env.PATH,
                      ...(process.env.ORI_CLAUDE_BIN === undefined ||
                      process.env.ORI_CLAUDE_BIN.trim() === ""
                        ? {}
                        : { ORI_CLAUDE_BIN: process.env.ORI_CLAUDE_BIN })
                    },
                    stateRoot
                  })
                )
              ),
            catch: (cause) =>
              new EvalSetupRunnerError({
                operation: "call Ori authoring",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause
              })
          });
        }).pipe(Effect.provide(NodeHttpClient.layerUndici))
      )
  });

  const runner = EvalSetupRunner.layer({
    validate: (result) =>
      Effect.gen(function* () {
        const scratch = scratchOf(result);
        if (scratch === undefined) {
          return yield* new EvalSetupRunnerError({
            operation: "validate",
            detail: "validation uses Ori's dry-run after an artifact exists"
          });
        }
        yield* validateEvals(scratch).pipe(
          Effect.provide(
            Layer.mergeAll(
              makeEvalEngineLayer({
                execute: () => Effect.die(new Error("validation must never execute eval calls"))
              }),
              NodeServicesLayer
            )
          ),
          Effect.mapError(
            (cause) =>
              new EvalSetupRunnerError({
                operation: "validate",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause
              })
          )
        );
      }),
    estimate: (result, mode) =>
      estimateFromOri(result, mode).pipe(Effect.provide(NodeServicesLayer)),
    publish: (input) =>
      Effect.gen(function* () {
        const completed = completedResult(input.result);
        const run = selectLatestSuccessfulOriEvalRun(completed);
        const observed = evalExecutionModels(run);
        if (observed.judgeModels[0] === undefined) {
          return yield* new EvalSetupRunnerError({
            operation: "publish",
            detail: "structured Ori evidence does not identify a judge model"
          });
        }
        const handoff = yield* publishOriEvalPolicyHandoff({
          profile: {
            version: 1,
            id: input.profileId,
            description: input.description,
            suite: `.routekit/evals/${input.profileId}`,
            candidates: [...observed.candidateModels],
            judge: observed.judgeModels[0],
            eligibility: { minimumPassRate: 0.8, minimumJudgeScore: 0.8 },
            objective: input.objective
          },
          repositoryRoot: input.repositoryRoot,
          result: completed,
          snapshotRoot: options.snapshotRoot
        }).pipe(
          Effect.mapError(
            (cause) =>
              new EvalSetupRunnerError({
                operation: "publish",
                detail: cause.message,
                cause
              })
          )
        );
        return { comparison: handoff.comparison, proposal: handoff.policy };
      })
  });

  return EvalSetupLive.pipe(
    Layer.provide(Layer.mergeAll(authoring, runner)),
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.provide(NodeServicesLayer)
  );
};

export { estimateFromOri };
