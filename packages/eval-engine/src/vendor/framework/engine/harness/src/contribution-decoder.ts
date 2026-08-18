import { Context, Effect, Layer } from "effect";

import type { AgentHarnessContributionShape } from "../../../contracts/internal/src/author-schemas/agent-harness.ts";

import { decodeAgentHarnessContributionShape as decodeAgentHarnessContributionShapeContract } from "../../../contracts/internal/src/author-schemas/agent-harness.ts";
import { HarnessValidationError } from "../../../contracts/internal/src/errors.ts";

export interface AgentHarnessContributionDecoderShape {
  readonly decode: (
    input: unknown
  ) => Effect.Effect<AgentHarnessContributionShape, HarnessValidationError>;
}

export const decodeAgentHarnessContribution = Effect.fn(
  "AgentHarnessContribution.decode"
)(function* (input: unknown) {
  return yield* decodeAgentHarnessContributionShapeContract(input).pipe(
    Effect.mapError(
      (cause) =>
        new HarnessValidationError({
          cause,
          detail: "Invalid agent harness contribution",
        })
    )
  );
});

export class AgentHarnessContributionDecoder extends Context.Service<
  AgentHarnessContributionDecoder,
  AgentHarnessContributionDecoderShape
>()("ori/harness/AgentHarnessContributionDecoder") {
  static readonly layer = Layer.succeed(AgentHarnessContributionDecoder)(
    AgentHarnessContributionDecoder.of({
      decode: decodeAgentHarnessContribution,
    })
  );
}
