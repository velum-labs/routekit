import { Config, Context, Effect, Layer, Option, Schema } from "effect";

import type {
  LogFields,
  LoggerShape,
  LogLevel,
  LogRecord,
  LogSinkShape,
} from "../../../contracts/internal/src/runtime/services.ts";
import type { TelemetryUsageSinkShape } from "../../../contracts/internal/src/runtime/telemetry-usage-sink.ts";

import { USAGE_EVENT_MARKER } from "../../../contracts/author/src/usage-event.ts";
import { CliIo } from "../../../contracts/internal/src/cli/cli-io.ts";
import { LogSink } from "../../../contracts/internal/src/runtime/log-sink.ts";
import { TelemetryUsageSink } from "../../../contracts/internal/src/runtime/telemetry-usage-sink.ts";
import { formatUnknownError } from "../../../utils/core/src/error-formatting.ts";

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const DEFAULT_LOG_LEVEL: LogLevel = "info";
const ROOT_SCOPE = "routekit-eval";
const ROUTEKIT_EVAL_LOG_LEVEL_ENV = "ROUTEKIT_EVAL_LOG_LEVEL";

const isLogLevel = (value: string): value is LogLevel =>
  Object.hasOwn(LOG_LEVEL_RANK, value);

/** Parse an `ROUTEKIT_EVAL_LOG_LEVEL` string into a {@link LogLevel}, falling back to `info`. */
const parseLogLevel = (value: string): LogLevel => {
  const normalized = value.trim().toLowerCase();
  return isLogLevel(normalized) ? normalized : DEFAULT_LOG_LEVEL;
};

/** Reads the minimum log level from `ROUTEKIT_EVAL_LOG_LEVEL`, defaulting to `info`. */
const readLogLevelConfig: Effect.Effect<LogLevel> = Config.string(
  ROUTEKIT_EVAL_LOG_LEVEL_ENV
).pipe(
  Config.option,
  Effect.map((value) =>
    Option.isSome(value) ? parseLogLevel(value.value) : DEFAULT_LOG_LEVEL
  ),
  Effect.orElseSucceed(() => DEFAULT_LOG_LEVEL)
);

const safeJsonStringify = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

const formatFieldValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  return safeJsonStringify(value) ?? "[unserializable]";
};

const formatFields = (fields: LogFields): string =>
  Object.entries(fields)
    .map(([key, value]) => `${key}=${formatFieldValue(value)}`)
    .join(" ");

/** Renders a {@link LogRecord} as a single human-readable line (no trailing newline). */
const formatLogRecord = (record: LogRecord): string => {
  const parts = [`[${record.level}]`, `${record.scope}:`, record.message];
  if (record.fields !== undefined && Object.keys(record.fields).length > 0) {
    parts.push(formatFields(record.fields));
  }
  if (record.error !== undefined) {
    parts.push(`error=${formatUnknownError(record.error)}`);
  }
  return parts.join(" ");
};

const mergeFields = (
  base: LogFields | undefined,
  extra: LogFields | undefined
): LogFields | undefined => {
  if (base === undefined) {
    return extra;
  }
  if (extra === undefined) {
    return base;
  }
  return {
    ...base,
    ...extra,
  };
};

const joinScope = (parent: string, child: string): string =>
  parent.length === 0 ? child : `${parent}.${child}`;

const UsageEventFieldsSchema = Schema.Struct({
  event: Schema.String,
  props: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
    )
  ),
});

const writeUsageEvent = (
  usageSink: TelemetryUsageSinkShape,
  fields: LogFields | undefined
): Effect.Effect<void> => {
  if (fields === undefined || fields[USAGE_EVENT_MARKER] !== true) {
    return Effect.void;
  }
  if (!Schema.is(UsageEventFieldsSchema)(fields)) {
    return Effect.void;
  }
  return usageSink.write(fields.event, fields.props ?? {});
};

/**
 * Build a {@link LoggerShape} bound to `scope` and `boundFields` that writes
 * records to `sink`, dropping any below `minLevel`. `child` derives a sub-scoped
 * logger that inherits the sink, level, scope prefix, and bound fields.
 */
interface MakeLoggerOptions {
  readonly sink: LogSinkShape;
  readonly usageSink?: TelemetryUsageSinkShape | undefined;
  readonly minLevel: LogLevel;
  readonly scope?: string | undefined;
  readonly boundFields?: LogFields | undefined;
}

interface EmitInput {
  readonly level: LogLevel;
  readonly message: string;
  readonly error: unknown;
  readonly fields: LogFields | undefined;
}

interface LoggerShapeDeps {
  readonly sink: LogSinkShape;
  readonly usageSink: TelemetryUsageSinkShape;
  readonly enabled: (level: LogLevel) => boolean;
  readonly emit: (input: EmitInput) => ReturnType<LogSinkShape["write"]>;
  readonly makeChild: LoggerShape["child"];
}

const buildLoggerShape = (deps: LoggerShapeDeps): LoggerShape => {
  const { sink, usageSink, enabled, emit, makeChild } = deps;
  return {
    child: makeChild,
    debug: (message, fields) =>
      emit({
        error: undefined,
        fields,
        level: "debug",
        message,
      }),
    error: (message, error, fields) =>
      emit({
        error,
        fields,
        level: "error",
        message,
      }),
    info: (message, fields) =>
      emit({
        error: undefined,
        fields,
        level: "info",
        message,
      }),
    log: (record) => {
      if (record.fields?.[USAGE_EVENT_MARKER] === true) {
        return writeUsageEvent(usageSink, record.fields);
      }
      return enabled(record.level) ? sink.write(record) : Effect.void;
    },
    trace: (message, fields) =>
      emit({
        error: undefined,
        fields,
        level: "trace",
        message,
      }),
    warn: (message, fields) =>
      emit({
        error: undefined,
        fields,
        level: "warn",
        message,
      }),
  };
};

export const makeLogger = (options: MakeLoggerOptions): LoggerShape => {
  const {
    sink,
    usageSink = { write: (): Effect.Effect<void> => Effect.void },
    minLevel,
    scope = ROOT_SCOPE,
    boundFields,
  } = options;
  const enabled = (level: LogLevel): boolean =>
    LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[minLevel];
  const emit = (input: EmitInput): ReturnType<LogSinkShape["write"]> => {
    const merged = mergeFields(boundFields, input.fields);
    if (merged?.[USAGE_EVENT_MARKER] === true) {
      return writeUsageEvent(usageSink, merged);
    }
    if (!enabled(input.level)) {
      return Effect.void;
    }
    return sink.write({
      level: input.level,
      message: input.message,
      scope,
      fields: merged,
      error: input.error,
    });
  };
  const makeChild: LoggerShape["child"] = (childScope, childFields) =>
    makeLogger({
      boundFields: mergeFields(boundFields, childFields),
      minLevel,
      scope: joinScope(scope, childScope),
      sink,
      usageSink,
    });
  return buildLoggerShape({
    emit,
    enabled,
    makeChild,
    sink,
    usageSink,
  });
};

/**
 * The framework-wide diagnostic logger. Built over the {@link LogSink} in
 * context and the `ROUTEKIT_EVAL_LOG_LEVEL` minimum level.
 */
export class Logger extends Context.Service<Logger, LoggerShape>()(
  "routekit-eval/runtime/Logger"
) {
  static readonly layer = Layer.effect(Logger)(
    Effect.gen(function* () {
      const sink = yield* LogSink;
      const context = yield* Effect.context();
      const usageSink = Context.getOption(context, TelemetryUsageSink).pipe(
        Option.getOrElse(() =>
          TelemetryUsageSink.of({
            write: () => Effect.void,
          })
        )
      );
      const minLevel = yield* readLogLevelConfig;
      return Logger.of(
        makeLogger({
          minLevel,
          sink,
          usageSink,
        })
      );
    })
  );
}

/**
 * The live CLI {@link LogSink} adapter: writes one formatted line per record to
 * stderr via {@link CliIo}, so diagnostics never collide with `stdout` results
 * (RFC 0011). A failed write is ignored — a logger cannot meaningfully log its
 * own failure. Keeps {@link CliIo} in its requirement channel (does not
 * self-provide it), mirroring how `RuntimeSecretStoreLive` keeps
 * `RuntimeEnvironment` in its channel; root wiring supplies `CliIo`.
 */
export const CliLogSinkLive: Layer.Layer<LogSink, never, CliIo> = Layer.effect(
  LogSink
)(
  Effect.gen(function* () {
    const cliIo = yield* CliIo;
    return LogSink.of({
      write: (record) =>
        cliIo.writeStderr(`${formatLogRecord(record)}\n`).pipe(Effect.ignore),
    });
  })
);

export { parseLogLevel, readLogLevelConfig, formatLogRecord };
export type { MakeLoggerOptions };
