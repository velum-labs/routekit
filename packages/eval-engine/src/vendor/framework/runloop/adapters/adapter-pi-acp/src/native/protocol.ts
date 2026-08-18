import { Data } from "effect";

import type { NativeLineCodec } from "../../../../../engine/acp-adapter-kit/src/native-line-codec.ts";

import { makeNativeLineCodec } from "../../../../../engine/acp-adapter-kit/src/native-line-codec.ts";

import type { PiCommand, PiInbound } from "./schema.ts";

import {
  KNOWN_INBOUND_TYPES,
  PiCommand as PiCommandSchema,
  PiEnvelope as PiEnvelopeSchema,
  PiInbound as PiInboundSchema,
} from "./schema.ts";

class PiProtocolError extends Data.TaggedError("PiProtocolError")<{
  readonly detail: string;
}> {}

/**
 * A native event whose top-level `type` is not one this adapter models. It
 * decodes successfully (rather than failing the stream) so the projection can
 * emit an "unrecognized native event" diagnostic and keep draining.
 */
class PiUnknownEvent extends Data.TaggedClass("PiUnknownEvent")<{
  readonly diagnosticHarness: string | undefined;
  readonly type: string;
}> {}

/**
 * A JSONL line that could not be decoded at all (invalid JSON, invalid UTF-8,
 * or a modeled type whose required payload failed to decode — e.g. a renamed
 * field). It flows through the event stream so a single bad record becomes a
 * diagnostic instead of tearing the connection down.
 */
class PiMalformedLine extends Data.TaggedClass("PiMalformedLine")<{
  readonly detail: string;
}> {}

type PiDecodedLine = PiInbound | PiUnknownEvent;

const protocolFailure = (detail: string): PiProtocolError =>
  new PiProtocolError({ detail });

const codec: NativeLineCodec<PiDecodedLine, PiCommand, PiProtocolError> =
  makeNativeLineCodec({
    commandSchema: PiCommandSchema,
    envelopeSchema: PiEnvelopeSchema,
    inboundSchema: PiInboundSchema,
    knownInboundTypes: KNOWN_INBOUND_TYPES,
    malformedCommandDetail: "Malformed Pi command",
    malformedLineDetail: "Malformed Pi JSONL record",
    onUnknownEvent: ({ diagnosticHarness, type }) =>
      new PiUnknownEvent({
        diagnosticHarness,
        type,
      }),
    protocolFailure,
  });

const decodePiLine = codec.decodeLine;
const encodePiCommand = codec.encodeCommand;

export {
  decodePiLine,
  encodePiCommand,
  PiMalformedLine,
  PiProtocolError,
  PiUnknownEvent,
};
export type { PiDecodedLine };
