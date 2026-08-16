import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { EVAL_CONTRACT_VERSION } from "@velum-labs/routekit-eval-contracts";
import { compileRoutingPolicy } from "@velum-labs/routekit-eval-core";
import type { OriEvalResult, SetupEstimate } from "@velum-labs/routekit-eval-setup";
import { makeRoutingSnapshotStore } from "@velum-labs/routekit-eval-store";
import { Data, Effect } from "effect";
import { HttpClient } from "effect/unstable/http";

import {
  type PromotedOriAuthoredArtifacts,
  promoteOriAuthoredArtifacts
} from "./ori-artifact-promotion.js";
import { makeEvalComparisonRunner } from "./production-runner.js";

export class OriAuthoredProfileExecutionError extends Data.TaggedError(
  "OriAuthoredProfileExecutionError"
)<{
  readonly phase: "comparison" | "estimate" | "promotion" | "publication";
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export const executeOriAuthoredProfile = (input: {
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly result: OriEvalResult;
  readonly gatewayUrl: string;
  readonly bearerCredential: string;
  readonly snapshotRoot: string;
}): Effect.Effect<
  {
    readonly artifacts: PromotedOriAuthoredArtifacts;
    readonly estimate: SetupEstimate;
    readonly comparison: ReturnType<typeof compileRoutingPolicy> extends never
      ? never
      : import("@velum-labs/routekit-eval-contracts").EvalComparisonResult;
    readonly policy: import("@velum-labs/routekit-eval-contracts").CompiledRoutingPolicy;
    readonly snapshot: import("@velum-labs/routekit-eval-contracts").PublishedRoutingSnapshot;
  },
  OriAuthoredProfileExecutionError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const artifacts = yield* promoteOriAuthoredArtifacts({
      profileId: input.profileId,
      repositoryRoot: input.repositoryRoot,
      result: input.result
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OriAuthoredProfileExecutionError({
            phase: "promotion",
            detail: cause.message,
            cause
          })
      )
    );
    const runner = yield* makeEvalComparisonRunner({
      bearerCredential: input.bearerCredential
    });
    const request = {
      version: EVAL_CONTRACT_VERSION,
      profileId: artifacts.profile.id,
      suitePath: artifacts.directory,
      candidateModels: artifacts.profile.candidates,
      judgeModel: artifacts.profile.judge,
      gatewayUrl: input.gatewayUrl,
      concurrency: 4,
      timeoutMs: 300_000
    } as const;
    const estimate = yield* runner.estimate(request, "pilot").pipe(
      Effect.mapError(
        (cause) =>
          new OriAuthoredProfileExecutionError({
            phase: "estimate",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause
          })
      )
    );
    if (estimate.callCount <= 0) {
      return yield* new OriAuthoredProfileExecutionError({
        phase: "estimate",
        detail: "prospective authored comparison estimate contains no model calls"
      });
    }
    const comparison = yield* runner.runComparison(request, "pilot").pipe(
      Effect.mapError(
        (cause) =>
          new OriAuthoredProfileExecutionError({
            phase: "comparison",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause
          })
      )
    );
    const policy = yield* Effect.try({
      try: () => compileRoutingPolicy(artifacts.profile, comparison),
      catch: (cause) =>
        new OriAuthoredProfileExecutionError({
          phase: "comparison",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause
        })
    });
    const snapshot = yield* makeRoutingSnapshotStore(input.snapshotRoot)
      .publish(policy)
      .pipe(
        Effect.provide(NodeServicesLayer),
        Effect.mapError(
          (cause) =>
            new OriAuthoredProfileExecutionError({
              phase: "publication",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause
            })
        )
      );
    return { artifacts, estimate, comparison, policy, snapshot };
  });
