import { Context, Effect, Layer } from "effect";

import { EvalSetupRunnerError } from "./errors.js";
import type { EvalSetupRunnerShape } from "./types.js";

export class EvalSetupRunner extends Context.Service<EvalSetupRunner, EvalSetupRunnerShape>()(
  "@velum-labs/routekit-eval-setup/EvalSetupRunner"
) {
  static layer(service: EvalSetupRunnerShape) {
    return Layer.succeed(EvalSetupRunner, EvalSetupRunner.of(service));
  }
}

const unavailable = (operation: string) =>
  Effect.fail(
    new EvalSetupRunnerError({
      operation,
      detail: "EvalSetupRunner is not configured"
    })
  );

export const EvalSetupRunnerNoop = EvalSetupRunner.layer({
  validate: () => Effect.void,
  estimate: () => Effect.succeed({ callCount: 0, pricingKnown: false }),
  publish: () => unavailable("publishing an activation")
});
