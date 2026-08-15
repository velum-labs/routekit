import { Schema } from "effect";

class ClaudeCredentialError extends Schema.TaggedErrorClass<ClaudeCredentialError>()(
  "ClaudeCredentialError",
  { detail: Schema.String }
) {}

class ClaudeSessionStateError extends Schema.TaggedErrorClass<ClaudeSessionStateError>()(
  "ClaudeSessionStateError",
  { detail: Schema.String }
) {}

class ClaudeVersionError extends Schema.TaggedErrorClass<ClaudeVersionError>()(
  "ClaudeVersionError",
  { detail: Schema.String }
) {}

// `detail` is the operator-facing reason the boundary `errorMessage` helper
// surfaces (it reads `detail`, not `rawStdout`); `rawStdout` is kept verbatim
// for structured logging.
class ClaudeVersionParseError extends Schema.TaggedErrorClass<ClaudeVersionParseError>()(
  "ClaudeVersionParseError",
  {
    detail: Schema.String,
    rawStdout: Schema.String,
  }
) {}

export {
  ClaudeCredentialError,
  ClaudeSessionStateError,
  ClaudeVersionError,
  ClaudeVersionParseError,
};
