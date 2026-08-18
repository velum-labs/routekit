import { Data } from "effect";

import type { ClaudeCommand, ClaudeInbound } from "./schema.ts";
import type { NativeLineCodec } from "../../../../../engine/acp-adapter-kit/src/native-line-codec.ts";

import {
  ClaudeCommand as ClaudeCommandSchema,
  ClaudeEnvelope as ClaudeEnvelopeSchema,
  ClaudeInbound as ClaudeInboundSchema,
  KNOWN_INBOUND_TYPES,
} from "./schema.ts";
import { makeNativeLineCodec } from "../../../../../engine/acp-adapter-kit/src/native-line-codec.ts";

class ClaudeProtocolError extends Data.TaggedError("ClaudeProtocolError")<{
  readonly detail: string;
}> {}

/**
 * A native record whose top-level `type` is not one this adapter models. It
 * decodes successfully (rather than failing the stream) so the projection can
 * emit an "unrecognized native event" diagnostic and keep draining.
 */
class ClaudeUnknownEvent extends Data.TaggedClass("ClaudeUnknownEvent")<{
  readonly diagnosticHarness: string | undefined;
  readonly type: string;
}> {}

/**
 * A JSONL line that could not be decoded at all (invalid JSON, invalid UTF-8,
 * or a modeled type whose required payload failed to decode — e.g. a renamed
 * field). It flows through the event stream so a single bad record becomes a
 * diagnostic instead of tearing the connection down.
 */
class ClaudeMalformedLine extends Data.TaggedClass("ClaudeMalformedLine")<{
  readonly detail: string;
}> {}

type ClaudeDecodedLine = ClaudeInbound | ClaudeUnknownEvent;

const protocolFailure = (detail: string): ClaudeProtocolError =>
  new ClaudeProtocolError({ detail });

const codec: NativeLineCodec<
  ClaudeDecodedLine,
  ClaudeCommand,
  ClaudeProtocolError
> = makeNativeLineCodec({
  commandSchema: ClaudeCommandSchema,
  envelopeSchema: ClaudeEnvelopeSchema,
  inboundSchema: ClaudeInboundSchema,
  knownInboundTypes: KNOWN_INBOUND_TYPES,
  malformedCommandDetail: "Malformed Claude command",
  malformedLineDetail: "Malformed Claude JSONL record",
  onUnknownEvent: ({ diagnosticHarness, type }) =>
    new ClaudeUnknownEvent({
      diagnosticHarness,
      type,
    }),
  protocolFailure,
});

const decodeClaudeLine = codec.decodeLine;
const encodeClaudeCommand = codec.encodeCommand;

export {
  ClaudeMalformedLine,
  ClaudeProtocolError,
  ClaudeUnknownEvent,
  decodeClaudeLine,
  encodeClaudeCommand,
};
export type { ClaudeDecodedLine };
