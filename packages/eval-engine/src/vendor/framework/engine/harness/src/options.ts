import { Effect } from "effect";

import type {
  HarnessInvokeOptions,
  HarnessType,
  RuntimeHarnessInvokeOptions,
} from "../../../contracts/internal/src/author-schemas/harness-options.ts";

import {
  buildHarnessInvokeOptions,
  decodeHarnessInvokeOptions as decodeHarnessInvokeOptionsContract,
  harnessType,
} from "../../../contracts/internal/src/author-schemas/harness-options.ts";
import { HarnessValidationError } from "../../../contracts/internal/src/errors.ts";

export { buildHarnessInvokeOptions, harnessType };
export type RuntimeHarnessCompactionOptions = Omit<
  RuntimeHarnessInvokeOptions,
  "outputSchema" | "prompt"
>;

export type { HarnessInvokeOptions, HarnessType, RuntimeHarnessInvokeOptions };

export const decodeHarnessInvokeOptions = Effect.fn(
  "HarnessInvokeOptions.decode"
)(function* (input: unknown) {
  return yield* decodeHarnessInvokeOptionsContract(input).pipe(
    Effect.mapError(
      (cause) =>
        new HarnessValidationError({
          cause,
          detail: "Invalid harness invoke options",
        })
    )
  );
});
