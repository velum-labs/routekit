import { Schema } from "effect";

import type { HooksContribution as AuthorHooksContribution } from "../../../author/src/hooks.ts";
import type { AssertAssignable } from "../type-boundary.ts";

type HooksContribution = AuthorHooksContribution;

const hookHandlerSchema = Schema.Unknown;

const findHooksContributionIssue = (
  hooks: Readonly<Record<string, unknown>>
): string | undefined => {
  for (const [key, handler] of Object.entries(hooks)) {
    if (!key.includes(".")) {
      return `hooks contribution key "${key}" must contain a "." separator (expected "provider.hook")`;
    }
    if (typeof handler !== "function") {
      return `hooks contribution "${key}" must be a function`;
    }
  }
  return undefined;
};

const HooksContributionSchema = Schema.Record(
  Schema.String,
  hookHandlerSchema
).check(Schema.makeFilter((hooks) => findHooksContributionIssue(hooks)));

type _HooksContributionSchemaEncodesAuthor = AssertAssignable<
  typeof HooksContributionSchema.Encoded,
  HooksContribution
>;

export const decodeHooksContribution = Schema.decodeUnknownEffect(
  HooksContributionSchema
);

export { findHooksContributionIssue };
export type { HooksContribution };
