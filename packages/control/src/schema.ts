import { ControlError } from "@velum-labs/routekit-runtime";
import { z } from "zod";
import type { ControlSchema } from "./method-registry.js";

/**
 * Schema vocabulary for the control method table.
 *
 * Every message authored here is a *tail*: the reported error reads
 * `<method> <tail>`, so a tail names the field it is about (`requires label`,
 * `limit must be a positive integer`). Nested tails are prefixed with their
 * parent path, which keeps `daemon.roll candidate requires binPath` readable
 * without any per-method message plumbing.
 */

/** Rejects a missing, non-string, or empty value. */
export function requiredString(field: string): z.ZodString {
  const error = `requires ${field}`;
  return z.string({ error }).min(1, { error });
}

/** Rejects a missing value distinctly from an out-of-domain one. */
export function requiredEnum<T extends string>(
  field: string,
  values: readonly T[]
): z.ZodEnum<Record<T, T>> {
  return z.enum(values as unknown as readonly [T, ...T[]], {
    error: (issue) =>
      issue.input === undefined
        ? `requires ${field}`
        : `${field} must be one of: ${values.join(", ")}`
  });
}

export function requiredBoolean(field: string): z.ZodBoolean {
  return z.boolean({ error: `requires ${field}` });
}

export function typedBoolean(field: string): z.ZodBoolean {
  return z.boolean({ error: `${field} must be boolean` });
}

/** Integer bounded below, reported with one message for every failure mode. */
export function boundedInt(minimum: number, error: string) {
  return z.int({ error }).min(minimum, { error });
}

/** Present-but-anything, as opposed to `z.unknown()` which also accepts absence. */
export function requiredUnknown(field: string) {
  return z.unknown().nonoptional({ error: `requires ${field}` });
}

/** Params that carry no fields and tolerate forward-compatible additions. */
export const openParams = z.looseObject({}) as unknown as z.ZodType<Record<string, never>>;

/** Params that carry no fields and reject anything at all. */
export const closedParams = z.strictObject({}) as unknown as z.ZodType<Record<string, never>>;

/** Result shape primitives, mirroring the shallow checks the protocol guarantees. */
export const resultValue = {
  array: z.array(z.unknown()),
  boolean: z.boolean(),
  number: z.number(),
  object: z.looseObject({}),
  string: z.string(),
  true: z.literal(true)
} as const;

function pathText(path: readonly PropertyKey[]): string {
  return path.map((segment) => String(segment)).join(".");
}

function issueTail(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    const scope = pathText(issue.path);
    return `${scope === "" ? "" : `${scope} `}does not accept ${issue.keys.join(", ")}`;
  }
  if (issue.code === "invalid_type" && issue.expected === "object") {
    return issue.path.length === 0
      ? "params must be an object"
      : `${pathText(issue.path)} must be an object`;
  }
  const parent = pathText(issue.path.slice(0, -1));
  return `${parent === "" ? "" : `${parent} `}${issue.message}`;
}

/**
 * Validate-only adapter. The candidate is returned untouched so the protocol
 * never rewrites a payload it merely inspected: idempotency fingerprints stay
 * byte-stable and unknown forward-compatible fields survive intact.
 */
function validator<T>(
  name: string,
  schema: z.ZodType,
  fail: (issue: z.core.$ZodIssue | undefined) => ControlError
): ControlSchema<T> {
  return {
    name,
    parse(value: unknown): T {
      const candidate = value === undefined ? {} : value;
      const outcome = schema.safeParse(candidate);
      if (!outcome.success) throw fail(outcome.error.issues[0]);
      return candidate as T;
    }
  };
}

export function paramsValidator<T>(method: string, schema: z.ZodType): ControlSchema<T> {
  return validator<T>(
    `${method}.params`,
    schema,
    (issue) =>
      new ControlError({
        code: "bad_request",
        message:
          issue === undefined ? `${method} params are invalid` : `${method} ${issueTail(issue)}`
      })
  );
}

export function resultValidator<T>(method: string, schema: z.ZodType): ControlSchema<T> {
  return validator<T>(`${method}.result`, schema, (issue) => {
    const field = issue?.path[0];
    if (field === undefined) {
      return new ControlError({
        code: "internal",
        message: `${method} handler returned an invalid result`,
        details: { reason: issue?.message ?? "result did not match the declared shape" }
      });
    }
    return new ControlError({
      code: "internal",
      message: `${method} handler returned an invalid result field: ${String(field)}`
    });
  });
}
