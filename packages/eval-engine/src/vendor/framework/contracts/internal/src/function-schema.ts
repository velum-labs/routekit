import { Schema } from "effect";

import type { AssertAssignable } from "./type-boundary.ts";

type UnknownFunction = (...args: readonly unknown[]) => unknown;

const FunctionSchema = Schema.declare<UnknownFunction>(
  (value): value is UnknownFunction => typeof value === "function",
  { identifier: "Function" }
);
type _FunctionSchemaEncodesContract = AssertAssignable<
  typeof FunctionSchema.Type,
  UnknownFunction
>;

export { FunctionSchema };
export type { UnknownFunction };
