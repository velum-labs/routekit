import { Data } from "effect";

export type { CodexNativeConnectionError } from "./native/connection.ts";

class CodexVersionError extends Data.TaggedError("CodexVersionError")<{
  readonly detail: string;
}> {}

export { CodexVersionError };
