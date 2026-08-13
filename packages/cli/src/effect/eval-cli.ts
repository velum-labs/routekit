import { readFileSync } from "node:fs";
import { join } from "node:path";

import { routekitHome } from "@velum-labs/routekit-config";
import {
  EVAL_CONTRACT_VERSION,
  EVAL_POLICY,
  type EvalPolicy,
  type EvalRunResult,
  type EvalSuiteSpec
} from "@velum-labs/routekit-eval-contracts";
import { runEvalSuite } from "@velum-labs/routekit-eval-core/effect";
import { makeEffectEvalStore } from "@velum-labs/routekit-eval-store/effect";
import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

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

export function evalRunCommand(input: EvalRunCliInput): Effect.Effect<EvalRunResult, Error> {
  return Effect.gen(function* () {
    const spec = yield* Effect.try({
      try: () => JSON.parse(readFileSync(input.specPath, "utf8")) as EvalSuiteSpec,
      catch: (cause) => routeKitError(cause)
    });
    if (spec.version !== EVAL_CONTRACT_VERSION) {
      return yield* Effect.fail(new Error("unsupported eval suite version"));
    }
    const result = yield* runEvalSuite(spec, {
      gatewayUrl: input.gatewayUrl,
      token: input.token
    });
    const store = makeEffectEvalStore(evalStoreRoot(input.env, input.storeRoot));
    yield* store.writeRawRun(result);
    return result;
  });
}

export function evalShowCommand(input: {
  runId: string;
  storeRoot?: string;
  env?: NodeJS.ProcessEnv;
}): Effect.Effect<EvalRunResult, Error> {
  return Effect.gen(function* () {
    const store = makeEffectEvalStore(evalStoreRoot(input.env, input.storeRoot));
    const result = yield* store.readRawRun(input.runId);
    if (result === undefined) {
      return yield* Effect.fail(new Error(`eval run ${input.runId} was not found`));
    }
    return result;
  });
}

export function policyShowCommand(): Effect.Effect<EvalPolicy> {
  return Effect.succeed(EVAL_POLICY);
}
