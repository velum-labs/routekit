/**
 * Client-side event contract for RFC 0012 usage telemetry
 * (docs/rfcs/0012-telemetry/event-registry.md). Events carry an anonymous
 * install/session identity and bounded props — never prompts, paths, or
 * credentials. Error props are sanitized before they reach this contract.
 */

import { Schema, SchemaTransformation } from "effect";
import { identity } from "effect/Function";

import type { TelemetryEventName } from "../../../contracts/internal/src/runtime/telemetry-observer.ts";

import { TELEMETRY_EVENT_NAMES } from "../../../contracts/internal/src/runtime/telemetry-observer.ts";

export const TelemetryEventNameSchema = Schema.Literals(TELEMETRY_EVENT_NAMES);
export type { TelemetryEventName } from "../../../contracts/internal/src/runtime/telemetry-observer.ts";
export { TELEMETRY_EVENT_NAMES };

export const MAX_EVENTS_PER_BATCH = 100;
const MAX_PROP_KEYS = 16;
const MAX_PROP_KEY_LENGTH = 64;
const MAX_STRING_PROP_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 512;
const MAX_ERROR_STACK_LENGTH = 2048;
const MAX_CAUSE_CHAIN_ITEM_LENGTH = 128;
const MAX_PLATFORM_LENGTH = 32;
const MAX_CLI_VERSION_LENGTH = 64;
const MAX_CAUSE_CHAIN_LENGTH = 5;

const maxPropStringLength = (key: string): number => {
  if (key === "message") {
    return MAX_ERROR_MESSAGE_LENGTH;
  }
  if (key === "stack") {
    return MAX_ERROR_STACK_LENGTH;
  }
  return MAX_STRING_PROP_LENGTH;
};

/** Prop values are bounded strings, integers, booleans, or short tag arrays. */
export const TelemetryPropValueSchema = Schema.Union([
  Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_ERROR_STACK_LENGTH))),
  Schema.Int,
  Schema.Boolean,
  Schema.Array(
    Schema.String.pipe(
      Schema.check(Schema.isMaxLength(MAX_CAUSE_CHAIN_ITEM_LENGTH))
    )
  ).pipe(Schema.check(Schema.isMaxLength(MAX_CAUSE_CHAIN_LENGTH))),
]);
export type TelemetryPropValue = typeof TelemetryPropValueSchema.Type;

/** Clean, already-bounded props: the wire shape and the in-memory buffer type. */
export const TelemetryPropsSchema = Schema.Record(
  Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_PROP_KEY_LENGTH))),
  TelemetryPropValueSchema
).pipe(
  Schema.check(
    Schema.makeFilter((props: Record<string, TelemetryPropValue>) => {
      if (Object.keys(props).length > MAX_PROP_KEYS) {
        return `telemetry props exceed ${MAX_PROP_KEYS} keys`;
      }
      for (const [key, value] of Object.entries(props)) {
        if (Array.isArray(value)) {
          if (key !== "cause_chain") {
            return `invalid string array prop: ${key}`;
          }
          if (
            value.some(
              (item: string) => item.length > MAX_CAUSE_CHAIN_ITEM_LENGTH
            )
          ) {
            return `invalid cause_chain prop: ${key}`;
          }
          continue;
        }
        if (typeof value !== "string") {
          continue;
        }
        const maxLength = maxPropStringLength(key);
        if (value.length > maxLength) {
          return `${key} exceeds ${maxLength} characters`;
        }
      }
    })
  )
);
export type TelemetryProps = typeof TelemetryPropsSchema.Type;

const clampPropValue = (
  key: string,
  value: unknown
): TelemetryPropValue | undefined => {
  if (typeof value === "string") {
    const maxLength = maxPropStringLength(key);
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return;
    }
    return Math.round(value);
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.length <= MAX_CAUSE_CHAIN_LENGTH &&
    value.every((item): item is string => typeof item === "string")
  ) {
    return value
      .slice(0, MAX_CAUSE_CHAIN_LENGTH)
      .map((item) =>
        item.length > MAX_CAUSE_CHAIN_ITEM_LENGTH
          ? item.slice(0, MAX_CAUSE_CHAIN_ITEM_LENGTH)
          : item
      );
  }
};

const RawTelemetryPropsSchema = Schema.Record(Schema.String, Schema.Unknown);
type RawTelemetryProps = typeof RawTelemetryPropsSchema.Type;

/**
 * Clamp raw author props to the RFC limits so a single oversized value never
 * poisons a whole batch: cap key count, key length, and string value length,
 * round numbers to integers, and drop non-finite numbers and non-primitives.
 * This is lossy normalization, so it lives in the schema's decode getter — a
 * `.check` filter can only reject a value, never rewrite it.
 */
const clampProps = (raw: RawTelemetryProps): TelemetryProps => {
  const entries: (readonly [string, TelemetryPropValue])[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (entries.length >= MAX_PROP_KEYS) {
      break;
    }
    const clamped = clampPropValue(key, value);
    if (clamped === undefined) {
      continue;
    }
    const boundedKey =
      key.length > MAX_PROP_KEY_LENGTH
        ? key.slice(0, MAX_PROP_KEY_LENGTH)
        : key;
    entries.push([boundedKey, clamped]);
  }
  return Object.fromEntries(entries);
};

/**
 * Intake transform: raw author props (any JSON record) decode into clean,
 * bounded {@link TelemetryPropsSchema} values via {@link clampProps}. Encoding
 * is a passthrough — the clean value is already the wire shape.
 */
export const TelemetryPropsFromInput = RawTelemetryPropsSchema.pipe(
  Schema.decodeTo(
    TelemetryPropsSchema,
    SchemaTransformation.transform<TelemetryProps, RawTelemetryProps>({
      decode: clampProps,
      encode: (clean) => clean,
    })
  )
);

/** Reusable truncating transform: raw string decodes to a length-bounded string. */
const clampedString = (
  max: number
): Schema.decodeTo<Schema.String, Schema.String> =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String.pipe(Schema.check(Schema.isMaxLength(max))),
      SchemaTransformation.transform({
        decode: (value: string) =>
          value.length > max ? value.slice(0, max) : value,
        encode: identity,
      })
    )
  );

export const TelemetryIdentitySchema = Schema.Struct({
  installId: Schema.String,
  sessionId: Schema.String,
  cliVersion: clampedString(MAX_CLI_VERSION_LENGTH),
  os: clampedString(MAX_PLATFORM_LENGTH),
  arch: clampedString(MAX_PLATFORM_LENGTH),
  envKind: Schema.Literals(["user", "ci", "dev"]),
});
export type TelemetryIdentity = typeof TelemetryIdentitySchema.Type;
export type TelemetryEnvKind = TelemetryIdentity["envKind"];

export const TelemetryEventSchema = Schema.Struct({
  event: TelemetryEventNameSchema,
  install_id: Schema.String,
  session_id: Schema.String,
  ts: Schema.String,
  cli_version: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(MAX_CLI_VERSION_LENGTH))
  ),
  os: Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_PLATFORM_LENGTH))),
  arch: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(MAX_PLATFORM_LENGTH))
  ),
  env_kind: Schema.Literals(["user", "ci", "dev"]),
  props: TelemetryPropsSchema,
});
export type TelemetryEvent = typeof TelemetryEventSchema.Type;

export const TelemetryBatchSchema = Schema.Struct({
  events: Schema.Array(TelemetryEventSchema).pipe(
    Schema.check(Schema.isMaxLength(MAX_EVENTS_PER_BATCH))
  ),
});
export type TelemetryBatch = typeof TelemetryBatchSchema.Type;

/**
 * Assemble a wire event from an already-clean identity and props: map the
 * camelCase identity to the snake_case wire shape and stamp the timestamp.
 * Clamping happens upstream (identity at decode, props via
 * {@link TelemetryPropsFromInput}), so this is pure assembly.
 */
export const makeTelemetryEvent = (input: {
  readonly event: TelemetryEventName;
  readonly identity: TelemetryIdentity;
  readonly now: Date;
  readonly props?: TelemetryProps;
}): TelemetryEvent => ({
  event: input.event,
  install_id: input.identity.installId,
  session_id: input.identity.sessionId,
  ts: input.now.toISOString(),
  cli_version: input.identity.cliVersion,
  os: input.identity.os,
  arch: input.identity.arch,
  env_kind: input.identity.envKind,
  props: input.props ?? {},
});
