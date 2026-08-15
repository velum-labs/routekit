import { Data } from "effect";

class PiCredentialError extends Data.TaggedError("PiCredentialError")<{
  readonly detail: string;
}> {}

/**
 * Durable state that cannot re-seed Pi's session registry. Load fails here
 * rather than switching Pi to a meaningless native target, because a blank or
 * whitespace session file would be interpreted as a path.
 */
class PiSessionStateError extends Data.TaggedError("PiSessionStateError")<{
  readonly detail: string;
}> {}

export { PiCredentialError, PiSessionStateError };
