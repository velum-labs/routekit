import { Context, Effect, Layer } from "effect";

import { EvalSetupRunnerError } from "./errors.js";
import type { OriEvalAuthoringApi } from "./ori-result.js";

export type OriAuthoringInput = {
  readonly profileId: string;
  readonly repositoryRoot: string;
};

export type OriEvalAuthoringShape = {
  readonly withAuthoring: <A>(
    input: OriAuthoringInput,
    use: (api: OriEvalAuthoringApi) => Promise<A>
  ) => Effect.Effect<A, EvalSetupRunnerError>;
};

export class OriEvalAuthoring extends Context.Service<OriEvalAuthoring, OriEvalAuthoringShape>()(
  "@velum-labs/routekit-eval-setup/OriEvalAuthoring"
) {
  static layer(service: OriEvalAuthoringShape) {
    return Layer.succeed(OriEvalAuthoring, OriEvalAuthoring.of(service));
  }
}

export const oriAuthoringFromApi = (api: OriEvalAuthoringApi): OriEvalAuthoringShape => ({
  withAuthoring: (_input, use) =>
    Effect.tryPromise({
      try: () => use(api),
      catch: (cause) =>
        new EvalSetupRunnerError({
          operation: "call Ori authoring",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause
        })
    })
});
