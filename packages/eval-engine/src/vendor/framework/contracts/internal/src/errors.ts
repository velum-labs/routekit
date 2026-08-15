import { Schema } from "effect";

import type { SchemaIssueDetail } from "./error-formatting.ts";
import type { AssertAssignable } from "./type-boundary.ts";

// RFC 0007: HarnessProtocolError now lives at the author tier so builtins reach
// it through the public `ori` SDK. Imported here for the local type unions
// below and re-exported so this module's 100+ consumers stay unchanged.
import {
  detailErrorMessage,
  HarnessProtocolError,
} from "../../author/src/harness-protocol-error.ts";
import { formatSchemaIssues } from "./error-formatting.ts";
import { formatUnknownError } from "../../../utils/core/src/error-formatting.ts";

const operationErrorMessage = (
  domain: string,
  operation: string,
  detail: string
): string => `${domain} error while ${operation}: ${detail}`;

const namedErrorMessage = (
  domain: string,
  name: string,
  detail: string
): string => `${domain} error for ${name}: ${detail}`;

const BrokenPipeCause = Schema.Struct({
  cause: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.String),
});
const decodeBrokenPipeCause = Schema.decodeUnknownOption(BrokenPipeCause);
const MAX_BROKEN_PIPE_CAUSE_DEPTH = 8;

/**
 * Whether `cause` (or anything it wraps) is an `EPIPE`. A closed stdout pipe is
 * a normal end to `ori … | head`, not a failure, but the platform buries the
 * `code` several `cause` levels down inside a `PlatformError`.
 */
const isBrokenPipeCause = (cause?: unknown): boolean => {
  // Bounded and cycle-guarded: a defect chain is attacker-shaped data here, and
  // `cause` can legitimately be self-referential.
  const visited = new Set<object>();
  let current: unknown = cause;
  for (let depth = 0; depth <= MAX_BROKEN_PIPE_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    if (visited.has(current)) {
      return false;
    }
    visited.add(current);
    const decoded = decodeBrokenPipeCause(current);
    if (decoded._tag === "None") {
      return false;
    }
    if (decoded.value.code === "EPIPE") {
      return true;
    }
    current = decoded.value.cause;
  }
  return false;
};

class CliIoError extends Schema.TaggedErrorClass<CliIoError>()("CliIoError", {
  cause: Schema.Defect(),
  operation: Schema.String,
}) {
  override readonly message = `CLI I/O failed while ${this.operation}`;
}

class FeatureLoaderError extends Schema.TaggedErrorClass<FeatureLoaderError>()(
  "FeatureLoaderError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    detail: Schema.String,
    operation: Schema.String,
  }
) {
  override readonly message = operationErrorMessage(
    "Feature loader",
    this.operation,
    this.detail
  );
}

class RegistryError extends Schema.TaggedErrorClass<RegistryError>()(
  "RegistryError",
  {
    detail: Schema.optionalKey(Schema.String),
    kind: Schema.String,
    name: Schema.String,
  }
) {
  override readonly message =
    this.detail ?? `No "${this.name}" entry in ${this.kind} registry`;
}

const MAX_HARNESS_STDERR_LINES = 10;
const MAX_HARNESS_STDERR_CHARS = 800;
const EMPTY_LENGTH = 0;

/**
 * Render harness stderr as a bounded, readable tail for the error message — the
 * last few lines and at most a few hundred characters, with a note when earlier
 * lines were dropped. The full stderr stays in the structured `stderr` field for
 * `--json`; this only keeps the human message from becoming an unbounded dump.
 */
const summarizeHarnessStderr = (stderr: string | undefined): string => {
  const trimmed = stderr?.trim();
  if (trimmed === undefined || trimmed.length === EMPTY_LENGTH) {
    return "";
  }
  const lines = trimmed.split("\n");
  const tailLines = lines.slice(-MAX_HARNESS_STDERR_LINES);
  const omitted = lines.length - tailLines.length;
  let tail = tailLines.join("\n");
  if (tail.length > MAX_HARNESS_STDERR_CHARS) {
    tail = `…${tail.slice(tail.length - MAX_HARNESS_STDERR_CHARS)}`;
  }
  const omittedNote =
    omitted > EMPTY_LENGTH
      ? ` (last ${tailLines.length} of ${lines.length} stderr lines)`
      : "";
  return `${omittedNote}: ${tail}`;
};

const formatHarnessProcessErrorMessage = (input: {
  readonly command: string;
  readonly exitCode?: number | undefined;
  readonly stderr?: string | undefined;
}): string => {
  const detail = summarizeHarnessStderr(input.stderr);
  return input.exitCode === undefined
    ? `Harness process failed to start: ${input.command}${detail}`
    : `Harness process exited with code ${input.exitCode}: ${input.command}${detail}`;
};

class HarnessProcessError extends Schema.TaggedErrorClass<HarnessProcessError>()(
  "HarnessProcessError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    command: Schema.String,
    exitCode: Schema.optionalKey(Schema.Number),
    stderr: Schema.optionalKey(Schema.String),
  }
) {
  override readonly message = formatHarnessProcessErrorMessage({
    command: this.command,
    exitCode: this.exitCode,
    stderr: this.stderr,
  });
}

class HarnessCapabilityError extends Schema.TaggedErrorClass<HarnessCapabilityError>()(
  "HarnessCapabilityError",
  {
    capability: Schema.String,
    detail: Schema.String,
  }
) {
  override readonly message = namedErrorMessage(
    "Harness capability",
    this.capability,
    this.detail
  );
}

class HarnessValidationError extends Schema.TaggedErrorClass<HarnessValidationError>()(
  "HarnessValidationError",
  {
    cause: Schema.Defect(),
    detail: Schema.String,
  }
) {
  override readonly message = detailErrorMessage(
    "Harness validation",
    this.detail
  );
}

class RuntimeValidationError extends Schema.TaggedErrorClass<RuntimeValidationError>()(
  "RuntimeValidationError",
  {
    cause: Schema.Defect(),
    detail: Schema.String,
  }
) {
  override readonly message = detailErrorMessage(
    "Runtime validation",
    this.detail
  );
}

class RuntimeJournalError extends Schema.TaggedErrorClass<RuntimeJournalError>()(
  "RuntimeJournalError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    detail: Schema.String,
    operation: Schema.String,
  }
) {
  override readonly message = operationErrorMessage(
    "Runtime journal",
    this.operation,
    this.detail
  );
}

class RuntimeEnvironmentError extends Schema.TaggedErrorClass<RuntimeEnvironmentError>()(
  "RuntimeEnvironmentError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    detail: Schema.String,
    operation: Schema.String,
  }
) {
  override readonly message = operationErrorMessage(
    "Runtime environment",
    this.operation,
    this.detail
  );
}

class RuntimeSecretError extends Schema.TaggedErrorClass<RuntimeSecretError>()(
  "RuntimeSecretError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    detail: Schema.String,
    name: Schema.String,
  }
) {
  override readonly message = namedErrorMessage(
    "Runtime secret",
    this.name,
    this.detail
  );
}

class RuntimeServerError extends Schema.TaggedErrorClass<RuntimeServerError>()(
  "RuntimeServerError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    detail: Schema.String,
    operation: Schema.String,
  }
) {
  override readonly message = operationErrorMessage(
    "Runtime server",
    this.operation,
    this.detail
  );
}

class RuntimeReloadInterruptedError extends Schema.TaggedErrorClass<RuntimeReloadInterruptedError>()(
  "RuntimeReloadInterruptedError",
  {
    detail: Schema.String,
  }
) {
  override readonly message = detailErrorMessage("Runtime reload", this.detail);
}

class CliFailureError extends Schema.TaggedErrorClass<CliFailureError>()(
  "CliFailureError",
  {
    detail: Schema.String,
    /** A concrete next step rendered on its own line by the CLI's top-level handler. */
    hint: Schema.optionalKey(Schema.String),
    /**
     * The `AgentFailure.code` this failure was built from, so `--json` reports
     * what went wrong rather than which class reported it. Absent when the
     * failure has no structured origin.
     */
    failureCode: Schema.optionalKey(Schema.String),
    /** The underlying failure, kept so `--json` can surface its structure (e.g. schema issues). */
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {
  override readonly message = this.detail;
}

class RuntimeClientError extends Schema.TaggedErrorClass<RuntimeClientError>()(
  "RuntimeClientError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    detail: Schema.String,
  }
) {
  override readonly message = detailErrorMessage("Runtime client", this.detail);
}

class RuntimeProtocolError extends Schema.TaggedErrorClass<RuntimeProtocolError>()(
  "RuntimeProtocolError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    detail: Schema.String,
  }
) {
  override readonly message = detailErrorMessage(
    "Runtime protocol",
    this.detail
  );
}

type HarnessError =
  | HarnessCapabilityError
  | HarnessProcessError
  | HarnessProtocolError
  | HarnessValidationError
  | RuntimeEnvironmentError
  | RuntimeSecretError;

type RuntimeClientFailure = RuntimeClientError | RuntimeProtocolError;

type RuntimeError =
  | RuntimeClientFailure
  | RuntimeEnvironmentError
  | RuntimeJournalError
  | RuntimeReloadInterruptedError
  | RuntimeServerError
  | RuntimeSecretError
  | RuntimeValidationError;

type OriError =
  | CliFailureError
  | CliIoError
  | FeatureLoaderError
  | HarnessError
  | RegistryError
  | RuntimeError;

/**
 * Schema union of every {@link OriError}. Each tagged-error class is itself a
 * schema, so this round-trips any framework error through JSON and is the
 * basis for the daemon's structured error envelope (RFC 0003): the client
 * recovers a tagged error instead of a flattened string.
 */
const OriErrorSchema = Schema.Union([
  CliFailureError,
  CliIoError,
  FeatureLoaderError,
  HarnessCapabilityError,
  HarnessProcessError,
  HarnessProtocolError,
  HarnessValidationError,
  RegistryError,
  RuntimeClientError,
  RuntimeEnvironmentError,
  RuntimeJournalError,
  RuntimeProtocolError,
  RuntimeReloadInterruptedError,
  RuntimeSecretError,
  RuntimeServerError,
  RuntimeValidationError,
]);

// Compile-time drift guard: the union and the `OriError` type must stay in
// lockstep, so every decoded member is an `OriError` and every `OriError`
// member is covered by the schema.
type _OriErrorSchemaDecodesToOriError = AssertAssignable<
  typeof OriErrorSchema.Type,
  OriError
>;
type _OriErrorIsCoveredBySchema = AssertAssignable<
  OriError,
  typeof OriErrorSchema.Type
>;

// Tagged error for a failed feature-manifest JSON parse, so the loader's
// `Effect.try` catch channel is typed instead of the raw `unknown` the
// language-service flags (unknownInEffectCatch). Defined after
// `formatUnknownError` so the getter does not reference it before its
// declaration (oxlint no-use-before-define).
export class FeatureManifestParseError extends Schema.TaggedErrorClass<FeatureManifestParseError>()(
  "FeatureManifestParseError",
  { cause: Schema.Defect() }
) {
  override get message(): string {
    return formatUnknownError(this.cause);
  }
}

export const makeCliFailureFromCause =
  (detail: string) =>
  (cause: unknown): CliFailureError =>
    new CliFailureError({ detail: `${detail}: ${formatUnknownError(cause)}` });

export {
  namedErrorMessage,
  CliIoError,
  isBrokenPipeCause,
  FeatureLoaderError,
  RegistryError,
  HarnessCapabilityError,
  HarnessProcessError,
  HarnessValidationError,
  RuntimeValidationError,
  RuntimeJournalError,
  RuntimeEnvironmentError,
  RuntimeSecretError,
  RuntimeServerError,
  RuntimeReloadInterruptedError,
  CliFailureError,
  RuntimeClientError,
  RuntimeProtocolError,
  OriErrorSchema,
  formatSchemaIssues,
  formatUnknownError,
};
export type {
  HarnessError,
  RuntimeClientFailure,
  RuntimeError,
  OriError,
  SchemaIssueDetail,
};
export { HarnessProtocolError };
