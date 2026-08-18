import { Effect } from "effect";

import type { ChatInteractionResponse } from "../../../../contracts/author/src/chat.ts";
import type { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";

import { RuntimeClientError } from "../../../../contracts/internal/src/errors.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

/** The request being settled. */
export interface AnsweredRequest {
  readonly correlationId: string;
  readonly kind: "elicitation" | "permission";
  readonly sessionId: string;
}

/** A settle call into the daemon or a test seam standing in for one. */
export type SettleInteraction = (
  response: ChatInteractionResponse
) => Promise<void>;

// The settle POST is a local acknowledgement, so anything slower than this is
// a degraded daemon; the bound keeps a stalled settle from delaying every
// subsequent stream event behind it.
const SETTLE_TIMEOUT = "10 seconds";

/**
 * Settle one request, reporting a failure on stderr rather than killing the
 * stream. Returns whether the daemon accepted it, so a caller can decide to
 * fall back.
 */
export const attemptSettle = (
  cliIo: CliIo["Service"],
  settle: SettleInteraction,
  settlement: ChatInteractionResponse
): Effect.Effect<boolean> =>
  Effect.tryPromise(() => settle(settlement)).pipe(
    // timeoutOrElse interrupts the in-flight settle (and its fetch),
    // not just the surrounding effect.
    Effect.timeoutOrElse({
      duration: SETTLE_TIMEOUT,
      orElse: () =>
        new RuntimeClientError({
          detail: `the settle timed out after ${SETTLE_TIMEOUT}`,
        }),
    }),
    Effect.as(true),
    Effect.catch((error) =>
      cliIo
        .writeStderr(
          `Could not settle interactive request ${settlement.correlationId}: ${formatUnknownError(error)}\n`
        )
        .pipe(Effect.ignore, Effect.as(false))
    )
  );
