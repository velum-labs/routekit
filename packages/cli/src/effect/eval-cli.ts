import { join } from "node:path";
import { routekitHome } from "@velum-labs/routekit-config";
import {
  EVAL_POLICY,
  type EvalPolicy,
  type EvalRunResult,
  EvalSuiteSpec
} from "@velum-labs/routekit-eval-contracts";
import { runEvalSuite } from "@velum-labs/routekit-eval-core";
import { makeEvalStore } from "@velum-labs/routekit-eval-store";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { RouteKitFailure, routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect, FileSystem, Schema } from "effect";

export type EvalRunCliInput = {
  specPath: string;
  gatewayUrl: string;
  token: string;
  storeRoot?: string;
  env?: NodeJS.ProcessEnv;
};

export function evalStoreRoot(env: NodeJS.ProcessEnv = process.env, explicit?: string): string {
  return explicit ?? join(routekitHome(env), "eval");
}

export function evalRunCommand(
  input: EvalRunCliInput
): Effect.Effect<EvalRunResult, Error, RouteKitPlatform> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(input.specPath);
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) => routeKitError(cause)
    });
    const spec = yield* Schema.decodeUnknownEffect(EvalSuiteSpec)(json).pipe(
      Effect.mapError((cause) => new RouteKitFailure({ message: String(cause) }))
    );
    const result = yield* runEvalSuite(spec, {
      gatewayUrl: input.gatewayUrl,
      token: input.token
    });
    const store = makeEvalStore(evalStoreRoot(input.env, input.storeRoot));
    yield* store.writeRawRun(result);
    return result;
  });
}

export function evalShowCommand(input: {
  runId: string;
  storeRoot?: string;
  env?: NodeJS.ProcessEnv;
}): Effect.Effect<EvalRunResult, Error, RouteKitPlatform> {
  return Effect.gen(function* () {
    const store = makeEvalStore(evalStoreRoot(input.env, input.storeRoot));
    const result = yield* store.readRawRun(input.runId);
    if (result === undefined) {
      return yield* new RouteKitFailure({ message: `eval run ${input.runId} was not found` });
    }
    return result;
  });
}

export function policyShowCommand(): Effect.Effect<EvalPolicy> {
  return Effect.succeed(EVAL_POLICY);
}
