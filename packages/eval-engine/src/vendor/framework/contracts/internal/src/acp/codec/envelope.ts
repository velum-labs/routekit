import { Effect, Option, Schema } from "effect";

import type { DecodeIssue } from "../errors.ts";
import type {
  AcpDecodedEnvelope,
  AcpRequestId,
} from "../protocol/profile.ts";

import {
  ACP_REDACTED_DIAGNOSTIC_ID,
  AcpInvalidEnvelopeError,
  AcpMalformedJsonError,
  AcpSchemaDecodeError,
} from "../errors.ts";
import { AcpDecodedEnvelope as AcpDecodedEnvelopeSchema } from "../protocol/profile.ts";

const MAX_ISSUE_KIND_LENGTH = 64;
const ParseFailureSummary = Schema.Struct({
  issue: Schema.Struct({
    _tag: Schema.String,
  }),
});
const decodeParseFailureSummary =
  Schema.decodeUnknownOption(ParseFailureSummary);

const safeIssues = (cause: unknown): readonly DecodeIssue[] =>
  Option.match(decodeParseFailureSummary(cause), {
    onNone: () => [
      {
        kind: "SchemaMismatch",
        path: [],
      },
    ],
    onSome: ({ issue }) => [
      {
        kind: issue._tag.slice(0, MAX_ISSUE_KIND_LENGTH),
        path: [],
      },
    ],
  });

const schemaFailure = (cause: unknown): AcpSchemaDecodeError =>
  new AcpSchemaDecodeError({ issues: safeIssues(cause) });

const parseJson = Effect.fn("AcpCodec.parseJson")(function* (input: string) {
  return yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
    input
  ).pipe(Effect.mapError(() => new AcpMalformedJsonError()));
});

const decodeAcpEnvelope = Effect.fn("AcpCodec.decodeEnvelope")(function* (
  input: unknown
): Effect.fn.Return<
  AcpDecodedEnvelope,
  AcpInvalidEnvelopeError | AcpMalformedJsonError
> {
  const value = typeof input === "string" ? yield* parseJson(input) : input;
  return yield* Schema.decodeUnknownEffect(AcpDecodedEnvelopeSchema)(
    value
  ).pipe(Effect.mapError(() => new AcpInvalidEnvelopeError()));
});

const safeRequestId = (
  requestId: AcpRequestId | Schema.Json
): null | number | typeof ACP_REDACTED_DIAGNOSTIC_ID =>
  typeof requestId === "number" || requestId === null
    ? requestId
    : ACP_REDACTED_DIAGNOSTIC_ID;

export { decodeAcpEnvelope, safeRequestId, schemaFailure };
