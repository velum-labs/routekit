import type { PlatformError } from "effect";

import { Effect } from "effect";

import { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";

export const mapPlatformError =
  (operation: string) =>
  <Success>(
    effect: Effect.Effect<Success, PlatformError.PlatformError>
  ): Effect.Effect<Success, RuntimeServerError> =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new RuntimeServerError({
            cause,
            detail: cause.message,
            operation,
          })
      )
    );
