import { Crypto, Effect, Option, Schema } from "effect";

const MAX_ERROR_MESSAGE_LENGTH = 512;
const MAX_ERROR_STACK_FRAMES = 10;
const MAX_ERROR_STACK_LENGTH = 2048;
const MAX_CAUSE_CHAIN_LENGTH = 5;
const FINGERPRINT_FRAME_COUNT = 5;
const STACK_FINGERPRINT_LENGTH = 16;
const HEX_RADIX = 16;
const MESSAGE_SHAPE_LENGTH = 24;
const GENERIC_ERROR_TAGS = new Set([
  "CliFailureError",
  "CliOutputAlreadyReported",
  "Error",
]);

const ErrorRecordSchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Unknown),
  exitCode: Schema.optionalKey(Schema.Number),
  message: Schema.optionalKey(Schema.String),
  stack: Schema.optionalKey(Schema.String),
});
type ErrorRecord = typeof ErrorRecordSchema.Type;
const decodeErrorRecord = Schema.decodeUnknownOption(ErrorRecordSchema);

export interface SanitizedCliError {
  readonly causeChain: readonly string[];
  readonly message: string;
  readonly stack: string;
  readonly stackForFingerprint: string;
  readonly explicitTag: string | undefined;
  readonly exitCode: number | undefined;
}

const readErrorRecord = (value: unknown): ErrorRecord | undefined =>
  Option.getOrUndefined(decodeErrorRecord(value));

const bounded = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

const escapeRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const basename = (value: string): string => {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
};

const normalizeFrame = (line: string): string => {
  const trimmed = line.trim();
  const match = /^at\s+(.*?)\s+\((.*)\)$/u.exec(trimmed);
  if (match !== null) {
    return `at ${match[1]} (${basename(match[2].replace(/:\d+(?::\d+)?$/u, ""))})`;
  }
  const location = /^at\s+(.*)$/u.exec(trimmed);
  return location === null
    ? trimmed
    : `at ${basename(location[1].replace(/:\d+(?::\d+)?$/u, ""))}`;
};

const sanitizeText = (value: string, homeDirectory: string): string => {
  const normalizedHomeDirectory = homeDirectory.replace(/[\\/]+$/u, "");
  let result =
    normalizedHomeDirectory.length > 1
      ? value.replaceAll(
          new RegExp(
            `${escapeRegExp(normalizedHomeDirectory)}(?=$|[\\\\/])`,
            "gu"
          ),
          "~"
        )
      : value;
  result = result.replaceAll(
    /(?:\/Users\/|\/home\/)[^/\s]+(?:\/[^\s]*)?|C:\\Users\\[^\\/\s]+(?:\\[^\s]*)?/giu,
    "<user-path>"
  );
  result = result.replaceAll(/\bhttps?:\/\/[^\s]+/giu, (url) =>
    url.replace(/[?&#].*$/u, "")
  );
  result = result.replaceAll(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    "<email>"
  );
  result = result.replaceAll(/\bsk-or-[A-Za-z0-9_-]+\b/gu, "<secret>");
  result = result.replaceAll(/\bsk-[A-Za-z0-9_-]+\b/gu, "<secret>");
  result = result.replaceAll(
    /\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2})\b/gu,
    "<secret>"
  );
  return result;
};

const readInnermostPayload = (
  value: unknown
): { readonly message: string; readonly stack: string } => {
  let current: unknown = value;
  let payload = {
    message: "",
    stack: "",
  };
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_LENGTH; depth += 1) {
    if (typeof current === "string") {
      if (current.length > 0) {
        payload = {
          message: current,
          stack: payload.stack,
        };
      }
      break;
    }
    const record = readErrorRecord(current);
    if (record === undefined) {
      break;
    }
    const message = record.message ?? "";
    const stack = record.stack ?? "";
    payload = {
      message: message.length > 0 ? message : payload.message,
      stack: stack.length > 0 ? stack : payload.stack,
    };
    current = record.cause;
  }
  return payload;
};

const readTag = (value: unknown): string | undefined =>
  readErrorRecord(value)?._tag;

const readExitCode = (value: unknown): number | undefined =>
  readErrorRecord(value)?.exitCode;

const readCauseChain = (value: unknown): readonly string[] => {
  const tags: string[] = [];
  let current: unknown = value;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_LENGTH; depth += 1) {
    const record = readErrorRecord(current);
    if (record === undefined) {
      break;
    }
    const tag = record._tag;
    if (tag !== undefined) {
      tags.push(tag);
    }
    current = record.cause;
  }
  return tags.toReversed();
};

export const sanitizeCliError = (input: {
  readonly error: unknown;
  readonly homeDirectory: string;
}): SanitizedCliError => {
  const payload = readInnermostPayload(input.error);
  const message = bounded(
    sanitizeText(payload.message, input.homeDirectory),
    MAX_ERROR_MESSAGE_LENGTH
  );
  const rawFrames = payload.stack
    .split(/\r?\n/u)
    .filter((line) => line.trim().startsWith("at "));
  const normalizedFrames = rawFrames
    .slice(0, MAX_ERROR_STACK_FRAMES)
    .map(normalizeFrame)
    .map((line) => sanitizeText(line, input.homeDirectory));
  const stackForFingerprint = normalizedFrames
    .slice(0, FINGERPRINT_FRAME_COUNT)
    .join("\n");
  return {
    causeChain: readCauseChain(input.error),
    explicitTag: readTag(input.error),
    message,
    stack: bounded(normalizedFrames.join("\n"), MAX_ERROR_STACK_LENGTH),
    stackForFingerprint,
    exitCode: readExitCode(input.error),
  };
};

export const isGenericErrorTag = (tag: string): boolean =>
  GENERIC_ERROR_TAGS.has(tag);

export const stableErrorClass = (
  input: SanitizedCliError,
  stackFingerprint: string
): string => {
  const meaningfulTag = input.causeChain.find((tag) => !isGenericErrorTag(tag));
  if (meaningfulTag !== undefined) {
    return meaningfulTag;
  }
  const messageShape =
    input.message
      .toLowerCase()
      .replaceAll(/\b\d+\b/gu, "#")
      .replaceAll(/[^a-z0-9#]+/gu, "_")
      .replaceAll(/^_+|_+$/gu, "")
      .slice(0, MESSAGE_SHAPE_LENGTH) || "unknown";
  return `error_${messageShape}_${stackFingerprint}`;
};

export const makeStackFingerprint = Effect.fn(
  "TelemetryError.makeStackFingerprint"
)(function* (stack: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(stack))
    .pipe(Effect.catchCause(() => Effect.succeed(new Uint8Array())));
  return [...digest]
    .map((byte) => byte.toString(HEX_RADIX).padStart(2, "0"))
    .join("")
    .slice(0, STACK_FINGERPRINT_LENGTH);
});

export {
  MAX_CAUSE_CHAIN_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_ERROR_STACK_FRAMES,
  MAX_ERROR_STACK_LENGTH,
};
