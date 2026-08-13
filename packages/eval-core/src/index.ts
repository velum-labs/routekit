import { Effect } from "effect";

import type { EvalRunResult, EvalSuiteSpec } from "@velum-labs/routekit-eval-contracts";

import type { EvalEgressOptions } from "./egress.js";
import { aggregateEvalResults, runEvalSuite as runEvalSuiteEffect } from "./run.js";

export { aggregateEvalResults };
export type { EvalEgressOptions };

/** Promise façade over Effect evaluation. The `/effect` subpath owns the Effect types. */
export async function runEvalSuite(
  spec: EvalSuiteSpec,
  egress: EvalEgressOptions
): Promise<EvalRunResult> {
  return await Effect.runPromise(runEvalSuiteEffect(spec, egress));
}
