import { Option, Schema } from "effect";

import type { AcpClientRequestFailure } from "../../acp-agent/src/service.ts";

/** The JSON-RPC code every adapter reports for an unclassified handler failure. */
export const ACP_INTERNAL_ERROR_CODE = -32_003;

export const acpRequestFailure = (
  message: string,
  code: number = ACP_INTERNAL_ERROR_CODE
): AcpClientRequestFailure => ({
  code,
  message,
});

// A settled prompt failure carries its reason as a plain `{ message }` object
// (see each adapter's `finishPrompt`), so the reason is decoded back out of that
// shape at this boundary rather than collapsed into the generic fallback and
// lost.
const CarriedFailure = Schema.Struct({ message: Schema.String });
const decodeCarriedFailure = Schema.decodeUnknownOption(CarriedFailure);

/**
 * The tail every adapter's `errorMessage` shares once its own provider-specific
 * first chance at a `detail` has missed: a real `Error` renders as its message,
 * a settled prompt failure as its carried `message`, and anything else as the
 * adapter's fallback.
 */
export const carriedFailureMessage = (
  error: unknown,
  fallback: string
): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return Option.match(decodeCarriedFailure(error), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });
};
