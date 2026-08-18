import type { Effect, Redacted } from "effect";

import { Schema } from "effect";

/**
 * Internal runtime-service contracts shared across engine domains. The concrete
 * `@ori-engine/runtime-io` adapters implement the service ports (now in
 * `runtime/runtime-environment.ts` and `runtime/runtime-secret-store.ts`);
 * consumers such as `@ori-engine/harness` depend only on those ports so the
 * engine domains stay peers (no engine-to-engine imports). This module keeps the
 * cross-cutting value types those ports and the logger share.
 */

export const RuntimeSecretName = {
  OpenRouterApiKey: "openrouter.apiKey",
} as const;

// The schema the discriminant type derives from, so a persistence/wire boundary
// can decode a secret name if one is ever added. Kept module-local (no external
// consumer yet), matching the chat-tui SelectionScope precedent.
const RuntimeSecretNameSchema = Schema.Enum(RuntimeSecretName);

export type RuntimeSecretName = typeof RuntimeSecretNameSchema.Type;

export type RuntimeEnvironmentMap = Readonly<
  Record<string, string | undefined>
>;

export type RuntimeSecretValue = Redacted.Redacted;

/**
 * Severity of a diagnostic log record, ordered least-to-most severe. The
 * framework-wide logger drops records below the configured minimum level.
 */
const LogLevelSchema = Schema.Literals([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
]);
export type LogLevel = typeof LogLevelSchema.Type;

/** Structured key/value context attached to a single log record. */
const LogFieldsSchema = Schema.Record(Schema.String, Schema.Unknown);
export type LogFields = typeof LogFieldsSchema.Type;

/**
 * One diagnostic log record. `scope` names the emitting component (e.g.
 * `dev.reload-watcher` or `feature:my-feature`); `fields` carries structured
 * context; `error` carries the offending value for `error`-level records.
 */
export const LogRecordSchema = Schema.Struct({
  level: LogLevelSchema,
  scope: Schema.String,
  message: Schema.String,
  fields: Schema.optional(LogFieldsSchema),
  error: Schema.optional(Schema.Unknown),
});
export type LogRecord = typeof LogRecordSchema.Type;

/**
 * Framework-wide diagnostic logger. This is the internal-diagnostics surface —
 * distinct from user-facing CLI output (`CliIo`), the agent runtime event
 * stream (`AgentRuntimeEvent`), and production telemetry. A logger is bound to a
 * scope; `child` derives a sub-scoped logger that inherits and merges fields.
 */
export interface LoggerShape {
  readonly log: (record: LogRecord) => Effect.Effect<void>;
  readonly trace: (message: string, fields?: LogFields) => Effect.Effect<void>;
  readonly debug: (message: string, fields?: LogFields) => Effect.Effect<void>;
  readonly info: (message: string, fields?: LogFields) => Effect.Effect<void>;
  readonly warn: (message: string, fields?: LogFields) => Effect.Effect<void>;
  readonly error: (
    message: string,
    error?: unknown,
    fields?: LogFields
  ) => Effect.Effect<void>;
  readonly child: (scope: string, fields?: LogFields) => LoggerShape;
}

/**
 * The terminal destination for log records. Different runtimes provide different
 * sinks (CLI stderr for headless runs; the daemon log hub when a TUI owns the
 * terminal) without consumers knowing which is active.
 */
export interface LogSinkShape {
  readonly write: (record: LogRecord) => Effect.Effect<void>;
}
