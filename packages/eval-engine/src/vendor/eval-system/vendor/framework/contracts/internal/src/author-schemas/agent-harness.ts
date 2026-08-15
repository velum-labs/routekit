import type { FastCheck } from "effect/testing";

import { Schema } from "effect";

/**
 * Effect Schema mirror of author-facing shapes from `@routekit-eval-contracts/author`.
 * Authors import the plain TypeScript types; the engine decodes against these
 * schemas. `AssertAssignable` keeps each schema Encoded type assignable to the
 * author contract so the two layers cannot drift.
 */
import type {
  AgentInteractionRequest,
  AgentSession,
  AgentSessionEvent,
  AgentHarness as AuthorAgentHarness,
  AgentHarnessContribution as AuthorAgentHarnessContribution,
} from "../../../author/src/index.ts";
import type { AssertAssignable } from "../type-boundary.ts";

import {
  AGENT_SESSION_CONTENT_ROLES,
  AGENT_SESSION_LIFECYCLE_EVENTS,
  AGENT_SESSION_RUNTIME_ITEM_TYPES,
} from "../../../author/src/index.ts";

import {
  AgentSessionItemStatusSchema,
  AgentSessionToolStatusSchema,
  ElicitationFieldSummarySchema,
  PermissionOptionKindSchema,
} from "./agent-runtime-event.ts";

type AgentHarness = AuthorAgentHarness;
type AgentHarnessContribution = AuthorAgentHarnessContribution;

const AgentHarnessContributionSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  init: Schema.declare<AgentHarness["init"]>(
    (value): value is AgentHarness["init"] => typeof value === "function",
    {
      identifier: "AgentHarnessInit",
      toArbitrary:
        () =>
        (fc): FastCheck.Arbitrary<AgentHarness["init"]> =>
          fc.constant(() => Promise.resolve()),
    }
  ),
});

const AgentSessionEventSchema = Schema.Union([
  Schema.Struct({
    contentIndex: Schema.optionalKey(Schema.UndefinedOr(Schema.Finite)),
    delta: Schema.String,
    event: Schema.Literal("content.delta"),
    itemId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    role: Schema.Literals(AGENT_SESSION_CONTENT_ROLES),
  }),
  Schema.Struct({
    data: Schema.Unknown,
    event: Schema.Literals(AGENT_SESSION_RUNTIME_ITEM_TYPES),
  }),
  Schema.Struct({
    event: Schema.Literal("tool.started"),
    input: Schema.optionalKey(Schema.Unknown),
    name: Schema.String,
    toolCallId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  }),
  Schema.Struct({
    event: Schema.Literal("tool.updated"),
    input: Schema.optionalKey(Schema.Unknown),
    name: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    output: Schema.optionalKey(Schema.Unknown),
    status: Schema.optionalKey(
      Schema.UndefinedOr(AgentSessionToolStatusSchema)
    ),
    toolCallId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  }),
  Schema.Struct({
    data: Schema.optionalKey(Schema.Unknown),
    event: Schema.Literal("item"),
    itemId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    itemType: Schema.String,
    status: Schema.optionalKey(
      Schema.UndefinedOr(AgentSessionItemStatusSchema)
    ),
  }),
  Schema.Struct({
    attempt: Schema.optionalKey(Schema.UndefinedOr(Schema.Finite)),
    delayMs: Schema.optionalKey(Schema.UndefinedOr(Schema.Finite)),
    event: Schema.Literals(AGENT_SESSION_LIFECYCLE_EVENTS),
    message: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    trigger: Schema.optionalKey(
      Schema.UndefinedOr(
        Schema.Union([
          Schema.Literal("automatic"),
          Schema.Literal("manual"),
          Schema.Literal("unknown"),
        ])
      )
    ),
  }),
]);

const AgentInteractionRequestSchema = Schema.Union([
  Schema.Struct({
    correlationId: Schema.String,
    fields: Schema.Array(ElicitationFieldSummarySchema),
    kind: Schema.Literal("elicitation"),
    message: Schema.String,
  }),
  Schema.Struct({
    correlationId: Schema.String,
    kind: Schema.Literal("permission"),
    operation: Schema.String,
    options: Schema.Array(PermissionOptionKindSchema),
  }),
]).pipe(Schema.toTaggedUnion("kind"));

const AgentInteractionResponseSchema = Schema.Struct({
  correlationId: Schema.String,
  response: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("permission"),
      option: PermissionOptionKindSchema,
    }),
    Schema.Struct({
      kind: Schema.Literal("elicitation"),
      values: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ]),
});

const AgentSessionSchema = Schema.Struct({
  id: Schema.String,
  prompt: Schema.declare<AgentSession["prompt"]>(
    (value): value is AgentSession["prompt"] => typeof value === "function",
    {
      identifier: "AgentSessionPrompt",
      toArbitrary:
        (): ((fc: {
          readonly constant: <A>(value: A) => FastCheck.Arbitrary<A>;
        }) => FastCheck.Arbitrary<AgentSession["prompt"]>) =>
        (fc) =>
          fc.constant(() =>
            (async function* (): AsyncGenerator<AgentSessionEvent> {
              yield {
                delta: "",
                event: "content.delta" as const,
                role: "assistant" as const,
              };
            })()
          ),
    }
  ),
  release: Schema.declare<AgentSession["release"]>(
    (value): value is AgentSession["release"] => typeof value === "function",
    {
      identifier: "AgentSessionRelease",
      toArbitrary:
        (): ((fc: {
          readonly constant: <A>(value: A) => FastCheck.Arbitrary<A>;
        }) => FastCheck.Arbitrary<AgentSession["release"]>) =>
        (fc) =>
          fc.constant(() => Promise.resolve()),
    }
  ),
  resumeToken: Schema.optionalKey(
    Schema.declare<NonNullable<AgentSession["resumeToken"]>>(
      (value): value is NonNullable<AgentSession["resumeToken"]> =>
        typeof value === "function",
      { identifier: "AgentSessionResumeToken" }
    )
  ),
  interrupt: Schema.optionalKey(
    Schema.declare<NonNullable<AgentSession["interrupt"]>>(
      (value): value is NonNullable<AgentSession["interrupt"]> =>
        typeof value === "function",
      { identifier: "AgentSessionInterrupt" }
    )
  ),
  respond: Schema.optionalKey(
    Schema.declare<NonNullable<AgentSession["respond"]>>(
      (value): value is NonNullable<AgentSession["respond"]> =>
        typeof value === "function",
      { identifier: "AgentSessionRespond" }
    )
  ),
});

type AgentHarnessContributionShape = typeof AgentHarnessContributionSchema.Type;
type _AgentSessionSchemaEncodesAuthor = AssertAssignable<
  typeof AgentSessionSchema.Encoded,
  AgentSession
>;
type _AgentHarnessContributionSchemaEncodesAuthor = AssertAssignable<
  typeof AgentHarnessContributionSchema.Encoded,
  AgentHarnessContribution
>;

export const decodeAgentHarnessContributionShape = Schema.decodeUnknownEffect(
  AgentHarnessContributionSchema
);

export { AgentHarnessContributionSchema };
export {
  AgentInteractionRequestSchema,
  AgentInteractionResponseSchema,
  AgentSessionEventSchema,
  AgentSessionSchema,
};
export type {
  AgentInteractionRequest,
  AgentSession,
  AgentSessionEvent,
  AgentHarness,
  AgentHarnessContribution,
  AgentHarnessContributionShape,
};
