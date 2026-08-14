import { join } from "node:path";
import { routekitHome } from "@velum-labs/routekit-config";
import {
  EVAL_POLICY,
  type EvalPolicy,
  type StoredEvalRun
} from "@velum-labs/routekit-eval-contracts";
import {
  discoverEvalPath,
  dryRunEvalPath,
  EvalService,
  listEvalPath,
  makeEvalServiceLayer,
  runEvalPath,
  type EvalServiceEvent,
  type EvalWorkload
} from "@velum-labs/routekit-eval-service";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { RouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect, FileSystem, Stream } from "effect";

export interface EvalPathCliInput {
  path: string;
  workingDirectory?: string;
  storeRoot?: string;
  env?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
}

export interface EvalExecutionCliInput extends EvalPathCliInput {
  workload: EvalWorkload;
  timeoutMs?: number;
}

export interface EvalRunCliInput extends EvalExecutionCliInput {
  gatewayUrl: string;
  tokenFile?: string;
  /** Host-only test/integration seam; Commander never accepts a token value. */
  gatewayToken?: string;
}

export function evalStoreRoot(env: NodeJS.ProcessEnv = process.env, explicit?: string): string {
  return explicit ?? join(routekitHome(env), "eval");
}

export function evalTokenFile(env: NodeJS.ProcessEnv = process.env, explicit?: string): string {
  return explicit ?? join(routekitHome(env), "secrets", "data-token");
}

const serviceLayer = (
  input: EvalPathCliInput,
  options: { gatewayUrl?: string; gatewayToken?: string } = {}
) =>
  makeEvalServiceLayer({
    repositoryRoot: evalStoreRoot(input.env, input.storeRoot),
    nodeExecutable: input.nodeExecutable ?? process.execPath,
    gatewayUrl: options.gatewayUrl ?? "http://127.0.0.1",
    gatewayToken: options.gatewayToken ?? "unused-for-discovery"
  });

export function evalDiscoverCommand(input: EvalPathCliInput) {
  return discoverEvalPath({
    target: input.path,
    ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory })
  }).pipe(Effect.provide(serviceLayer(input)));
}

export function evalListCommand(input: EvalPathCliInput) {
  return listEvalPath({
    target: input.path,
    ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory })
  }).pipe(Effect.provide(serviceLayer(input)));
}

const completion = <Tag extends "EvalDryRunCompleted" | "EvalRunCompleted">(
  events: Iterable<EvalServiceEvent>,
  tag: Tag
): Extract<EvalServiceEvent, { readonly _tag: Tag }> | undefined => {
  for (const event of events) {
    if (event._tag === tag) {
      return event as Extract<EvalServiceEvent, { readonly _tag: Tag }>;
    }
  }
  return undefined;
};

export function evalDryRunCommand(input: EvalExecutionCliInput) {
  const stream = dryRunEvalPath({
    target: input.path,
    workload: input.workload,
    ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
  }).pipe(Stream.provide(serviceLayer(input)));
  return Stream.runCollect(stream).pipe(
    Effect.flatMap((events) => {
      const completed = completion(events, "EvalDryRunCompleted");
      return completed === undefined
        ? Effect.fail(new RouteKitFailure({ message: "evaluation dry-run did not complete" }))
        : Effect.succeed(completed);
    })
  );
}

export function evalRunCommand(
  input: EvalRunCliInput
): Effect.Effect<StoredEvalRun, Error, RouteKitPlatform> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const gatewayToken =
      input.gatewayToken ??
      (yield* fs.readFileString(evalTokenFile(input.env, input.tokenFile))).trim();
    if (gatewayToken.length === 0) {
      return yield* new RouteKitFailure({ message: "eval gateway token file is empty" });
    }
    const stream = runEvalPath({
      target: input.path,
      workload: input.workload,
      ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
    }).pipe(
      Stream.provide(
        serviceLayer(input, {
          gatewayUrl: input.gatewayUrl,
          gatewayToken
        })
      )
    );
    const events = yield* Stream.runCollect(stream);
    const completed = completion(events, "EvalRunCompleted");
    if (completed === undefined) {
      return yield* new RouteKitFailure({ message: "evaluation run did not complete" });
    }
    return completed.run;
  });
}

export function evalShowCommand(input: {
  runId: string;
  storeRoot?: string;
  env?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
}): Effect.Effect<StoredEvalRun, Error> {
  return Effect.gen(function* () {
    const layer = serviceLayer({
      path: ".",
      ...(input.storeRoot === undefined ? {} : { storeRoot: input.storeRoot }),
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.nodeExecutable === undefined ? {} : { nodeExecutable: input.nodeExecutable })
    });
    const result = yield* Effect.gen(function* () {
      const service = yield* EvalService;
      return yield* service.readRun(input.runId);
    }).pipe(Effect.provide(layer));
    if (result === undefined) {
      return yield* new RouteKitFailure({ message: `eval run ${input.runId} was not found` });
    }
    return result;
  });
}

export const policyShowCommand: Effect.Effect<EvalPolicy> = Effect.succeed(EVAL_POLICY);
