import { Effect, Option, Schema } from "effect";

import { RouteKitEvalErrorSchema } from "../errors.ts";
import {
  decodeJsonString,
  encodeJsonStringSync,
} from "../json.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

/**
 * Structured error body the daemon returns on a failed HTTP request. `error` is
 * always a human-readable summary (for clients that only read text); `failure`
 * carries the encoded tagged error when the failure is a known {@link
 * RouteKitEvalError}, so a client can decode it back into the original typed instance
 * instead of parsing a flattened string (RFC 0003).
 */
const DaemonErrorEnvelopeSchema = Schema.Struct({
  error: Schema.String,
  failure: Schema.optionalKey(RouteKitEvalErrorSchema),
});

type DaemonErrorEnvelope = typeof DaemonErrorEnvelopeSchema.Type;
type DaemonErrorEnvelopeEncoded = typeof DaemonErrorEnvelopeSchema.Encoded;

const encodeFailure = Schema.encodeUnknownEffect(RouteKitEvalErrorSchema);
const decodeEnvelope = decodeJsonString(DaemonErrorEnvelopeSchema);

// Wire JSON for an already-encoded envelope (failure is plain JSON, not RouteKitEvalError instances).
const DaemonErrorEnvelopeWireSchema = Schema.Struct({
  error: Schema.String,
  failure: Schema.optionalKey(Schema.Unknown),
});
const encodeDaemonErrorEnvelopeJson = encodeJsonStringSync(
  DaemonErrorEnvelopeWireSchema
);

/**
 * Build the JSON body for a daemon error response. The `error` string always
 * renders the failure for text-only clients; `failure` is attached only when
 * `error` is a known tagged {@link RouteKitEvalError} that encodes cleanly, so plain
 * defects degrade to a string-only envelope rather than failing the response.
 */
export const encodeDaemonErrorEnvelope = (
  error: unknown
): Effect.Effect<DaemonErrorEnvelopeEncoded> =>
  encodeFailure(error).pipe(
    Effect.option,
    Effect.map((failure) => ({
      error: formatUnknownError(error),
      ...(Option.isSome(failure) ? { failure: failure.value } : {}),
    }))
  );

/**
 * Recover the tagged error from a daemon error response body. Returns the
 * reconstructed {@link RouteKitEvalError} when the body is a {@link
 * DaemonErrorEnvelopeSchema} carrying a `failure`, and `Option.none()` for a
 * plain-text body, non-envelope JSON, or an unknown tag — callers fall back to
 * their own client error in those cases.
 */
export const decodeDaemonErrorFailure = (
  body: string
): Effect.Effect<Option.Option<typeof RouteKitEvalErrorSchema.Type>> =>
  decodeEnvelope(body).pipe(
    Effect.map((envelope) =>
      envelope.failure === undefined
        ? Option.none()
        : Option.some(envelope.failure)
    ),
    Effect.orElseSucceed(() => Option.none())
  );

export { DaemonErrorEnvelopeSchema, encodeDaemonErrorEnvelopeJson };
export type { DaemonErrorEnvelope, DaemonErrorEnvelopeEncoded };
