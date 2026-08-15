import { Crypto, Effect } from "effect";

import { HarnessValidationError } from "../../../../contracts/internal/src/errors.ts";
import { AgentHarnessAdapter } from "../../../../engine/harness/src/adapter.ts";
import { AgentHarnessContributionDecoder } from "../../../../engine/harness/src/contribution-decoder.ts";
import { makeHarnessEventIds } from "../../../../engine/harness/src/events.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const makeRuntimeHarnessFromContribution = Effect.fn(
  "HarnessContribution.makeRuntime"
)(function* (input: unknown) {
  const adapter = yield* AgentHarnessAdapter;
  const crypto = yield* Crypto.Crypto;
  const decoder = yield* AgentHarnessContributionDecoder;
  const contribution = yield* decoder.decode(input);

  const harness = adapter.adapt(contribution, makeHarnessEventIds(crypto));
  if (harness.initialize !== undefined) {
    yield* harness.initialize.pipe(
      Effect.mapError(
        (cause) =>
          new HarnessValidationError({
            cause,
            detail: `Harness "${contribution.name}" failed during registration: ${formatUnknownError(cause)}`,
          })
      )
    );
  }
  return harness;
});

export { makeRuntimeHarnessFromContribution };
