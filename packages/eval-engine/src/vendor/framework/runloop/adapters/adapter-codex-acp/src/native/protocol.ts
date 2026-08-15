import { Data, Effect, Schema } from "effect";

import type {
  CodexAskUserRequest,
  CodexKnownSessionEvent,
  CodexRequestCommand,
  CodexResponse,
  CodexUnknownRequest,
  RequestId,
} from "./schema.ts";

import {
  CodexAskUserRequest as CodexAskUserRequestSchema,
  CodexAskUserResponse as CodexAskUserResponseSchema,
  CodexKnownSessionEvent as CodexKnownSessionEventSchema,
  CodexRequestCommand as CodexRequestCommandSchema,
  CodexResponse as CodexResponseSchema,
  CodexUnknownRequest as CodexUnknownRequestSchema,
  KNOWN_NOTIFICATION_METHODS,
} from "./schema.ts";
import {
  decodeJsonLineSync,
  encodeJsonStringSync,
} from "../../../../../contracts/internal/src/json.ts";

class CodexProtocolError extends Data.TaggedError("CodexProtocolError")<{
  readonly detail: string;
}> {}

/**
 * A notification whose method this adapter does not model. It decodes
 * successfully (rather than failing the stream) so the projection can emit an
 * "unrecognized native event" diagnostic and keep draining.
 */
class CodexUnknownEvent extends Data.TaggedClass("CodexUnknownEvent")<{
  readonly diagnosticHarness: string | undefined;
  readonly method: string;
}> {}

/**
 * A JSONL line that could not be decoded at all (invalid JSON, invalid UTF-8,
 * or a modeled type whose required payload failed to decode — e.g. a renamed
 * field). It flows through the event stream so a single bad record becomes a
 * diagnostic instead of tearing the connection down.
 */
class CodexMalformedLine extends Data.TaggedClass("CodexMalformedLine")<{
  readonly detail: string;
}> {}

type CodexDecodedLine =
  | CodexAskUserRequest
  | CodexKnownSessionEvent
  | CodexResponse
  | CodexUnknownEvent
  | CodexUnknownRequest;

const protocolFailure = (detail: string): CodexProtocolError =>
  new CodexProtocolError({ detail });

const MALFORMED_DETAIL = "Malformed Codex JSONL record";

// Every JSON-RPC envelope Codex can send is one of: a "response" to a request
// ORI sent (id, no method), a "request" Codex sent that ORI must answer (id
// and method), or a "notification" (method, no id). This lenient envelope
// tells the three apart before a specific schema is tried, mirroring the
// two-stage decode boundary the other ACP adapters use for their own wires.
const Envelope = Schema.Struct({
  diagnosticHarness: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Unknown),
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
});

const classifyResponse = (
  value: unknown
): Effect.Effect<CodexResponse, CodexProtocolError> =>
  Schema.decodeUnknownEffect(CodexResponseSchema)(value).pipe(
    Effect.mapError(() => protocolFailure(MALFORMED_DETAIL))
  );

// A recognized request (item/tool/requestUserInput) with a malformed payload
// still degrades to `CodexUnknownRequest` rather than failing the stream: the
// id must survive so the connection can answer it and Codex is never left
// blocked on a request this adapter could not fully decode.
const classifyRequest = (
  value: unknown
): Effect.Effect<
  CodexAskUserRequest | CodexUnknownRequest,
  CodexProtocolError
> =>
  Schema.decodeUnknownEffect(CodexAskUserRequestSchema)(value).pipe(
    Effect.catch(() =>
      Schema.decodeUnknownEffect(CodexUnknownRequestSchema)(value).pipe(
        Effect.mapError(() => protocolFailure(MALFORMED_DETAIL))
      )
    )
  );

// A known discriminant with a malformed payload MUST fail decoding; an unknown
// discriminant is recovered as a `CodexUnknownEvent` so it can be reported
// without losing the stream.
const classifyNotification = (
  value: unknown,
  envelope: typeof Envelope.Type
): Effect.Effect<
  CodexKnownSessionEvent | CodexUnknownEvent,
  CodexProtocolError
> =>
  Schema.decodeUnknownEffect(CodexKnownSessionEventSchema)(value).pipe(
    Effect.catch(() => {
      const { method } = envelope;
      if (method !== undefined && KNOWN_NOTIFICATION_METHODS.has(method)) {
        return Effect.fail(protocolFailure(MALFORMED_DETAIL));
      }
      return Effect.succeed(
        new CodexUnknownEvent({
          diagnosticHarness: envelope.diagnosticHarness,
          method: method ?? "codex.unknown-notification",
        })
      );
    })
  );

const decodeCodexLine = (
  line: string
): Effect.Effect<CodexDecodedLine, CodexProtocolError> =>
  Effect.try({
    catch: () => protocolFailure(MALFORMED_DETAIL),
    try: () => decodeJsonLineSync(Schema.Unknown)(line),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(Envelope, {
        onExcessProperty: "preserve",
      })(value).pipe(
        Effect.mapError(() => protocolFailure(MALFORMED_DETAIL)),
        Effect.flatMap(
          (envelope): Effect.Effect<CodexDecodedLine, CodexProtocolError> => {
            const hasId = "id" in envelope;
            const hasMethod = "method" in envelope;
            if (hasId && hasMethod) {
              return classifyRequest(value);
            }
            if (hasId) {
              return classifyResponse(value);
            }
            if (hasMethod) {
              return classifyNotification(value, envelope);
            }
            return Effect.fail(protocolFailure(MALFORMED_DETAIL));
          }
        )
      )
    )
  );

const encodeCodexCommand = (
  id: number,
  command: CodexRequestCommand
): Effect.Effect<string, CodexProtocolError> =>
  Schema.encodeEffect(CodexRequestCommandSchema)(command).pipe(
    Effect.map(
      (encoded) =>
        `${encodeJsonStringSync(Schema.Unknown)({
          id,
          jsonrpc: "2.0",
          ...encoded,
        })}\n`
    ),
    Effect.mapError(() => protocolFailure("Malformed Codex command"))
  );

const encodeCodexAskUserResponse = (
  id: RequestId,
  questionId: string,
  answers: readonly string[]
): Effect.Effect<string, CodexProtocolError> =>
  Schema.encodeEffect(CodexAskUserResponseSchema)({
    answers: { [questionId]: { answers } },
  }).pipe(
    Effect.map(
      (result) =>
        `${encodeJsonStringSync(Schema.Unknown)({
          id,
          jsonrpc: "2.0",
          result,
        })}\n`
    ),
    Effect.mapError(() =>
      protocolFailure("Malformed Codex user-input response")
    )
  );

// A request whose method this adapter does not recognize still owes Codex a
// reply; a JSON-RPC method-not-found error settles it without ever guessing
// at a made-up result.
const METHOD_NOT_FOUND = -32_601;
const encodeCodexRequestError = (id: RequestId, message: string): string =>
  `${encodeJsonStringSync(Schema.Unknown)({
    error: {
      code: METHOD_NOT_FOUND,
      message,
    },
    id,
    jsonrpc: "2.0",
  })}\n`;

export {
  CodexMalformedLine,
  CodexProtocolError,
  CodexUnknownEvent,
  decodeCodexLine,
  encodeCodexAskUserResponse,
  encodeCodexCommand,
  encodeCodexRequestError,
};
export type { CodexDecodedLine };
