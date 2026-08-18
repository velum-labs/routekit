import { Data } from "effect";

const ACP_REDACTED_DIAGNOSTIC_ID = "[redacted]";

type AcpDiagnosticRequestId = null | number | typeof ACP_REDACTED_DIAGNOSTIC_ID;

interface DecodeIssue {
  readonly kind: string;
  readonly path: readonly (string | number)[];
}

class AcpMalformedJsonError extends Data.TaggedError("AcpMalformedJsonError")<
  Record<never, never>
> {
  override readonly message = "ACP frame is not valid JSON";
}

class AcpSchemaDecodeError extends Data.TaggedError("AcpSchemaDecodeError")<{
  readonly issues: readonly DecodeIssue[];
}> {
  override readonly message =
    "ACP message does not match the supported protocol schema";
}

class AcpMalformedUtf8Error extends Data.TaggedError("AcpMalformedUtf8Error")<
  Record<never, never>
> {
  override readonly message = "ACP frame is not valid UTF-8";
}

class AcpInvalidEnvelopeError extends Data.TaggedError(
  "AcpInvalidEnvelopeError"
)<Record<never, never>> {
  override readonly message = "ACP message has an invalid JSON-RPC envelope";
}

class AcpUnknownMethodError extends Data.TaggedError("AcpUnknownMethodError")<{
  readonly method: string;
  readonly requestId?: AcpDiagnosticRequestId;
}> {
  override readonly message = `Unsupported ACP method: ${this.method}`;
}

class AcpUnexpectedResponseError extends Data.TaggedError(
  "AcpUnexpectedResponseError"
)<{
  readonly requestId: AcpDiagnosticRequestId;
}> {
  override readonly message = "ACP response has no matching pending request";
}

class AcpInvalidFramingConfigError extends Data.TaggedError(
  "AcpInvalidFramingConfigError"
)<Record<never, never>> {
  override readonly message =
    "ACP framing limits must be positive finite integers";
}

class AcpFrameTooLargeError extends Data.TaggedError("AcpFrameTooLargeError")<{
  readonly completedFrameCount: number;
  readonly limitBytes: number;
}> {
  override readonly message = `ACP frame exceeds ${this.limitBytes} bytes`;
}

class AcpBufferTooLargeError extends Data.TaggedError(
  "AcpBufferTooLargeError"
)<{
  readonly completedFrameCount: number;
  readonly limitBytes: number;
}> {
  override readonly message = `ACP pending buffer exceeds ${this.limitBytes} bytes`;
}

class AcpChunkTooLargeError extends Data.TaggedError("AcpChunkTooLargeError")<{
  readonly limitBytes: number;
}> {
  override readonly message = `ACP transport chunk exceeds ${this.limitBytes} bytes`;
}

class AcpTooManyFramesError extends Data.TaggedError("AcpTooManyFramesError")<{
  readonly completedFrameCount: number;
  readonly limitFrames: number;
}> {
  override readonly message = `ACP transport chunk exceeds ${this.limitFrames} frames`;
}

class AcpUnterminatedFrameError extends Data.TaggedError(
  "AcpUnterminatedFrameError"
)<{
  readonly pendingBytes: number;
}> {
  override readonly message = "ACP stream ended with an unterminated frame";
}

export {
  ACP_REDACTED_DIAGNOSTIC_ID,
  AcpBufferTooLargeError,
  AcpChunkTooLargeError,
  AcpFrameTooLargeError,
  AcpInvalidEnvelopeError,
  AcpInvalidFramingConfigError,
  AcpMalformedJsonError,
  AcpMalformedUtf8Error,
  AcpSchemaDecodeError,
  AcpTooManyFramesError,
  AcpUnterminatedFrameError,
  AcpUnexpectedResponseError,
  AcpUnknownMethodError,
};
export type { AcpDiagnosticRequestId, DecodeIssue };
