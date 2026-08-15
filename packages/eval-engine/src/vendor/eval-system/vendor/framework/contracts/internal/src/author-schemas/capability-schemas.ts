import { Schema } from "effect";

/**
 * Effect Schema mirror of author-facing shapes from `@routekit-eval-contracts/author`.
 * Authors import the plain TypeScript types; the engine decodes against these
 * schemas. `AssertAssignable` keeps each schema Encoded type assignable to the
 * author contract so the two layers cannot drift.
 */
import type {
  ChatContribution as AuthorChatContribution,
  CommandContribution as AuthorCommandContribution,
  ScheduleDefinition as AuthorScheduleDefinition,
  StateStore,
} from "../../../author/src/index.ts";
import type { AssertAssignable } from "../type-boundary.ts";

type CapabilityFunction = (...args: readonly never[]) => unknown;

type StateStoreContribution = StateStore;
type ChatContribution = AuthorChatContribution;
type ChatWarmupHandler = NonNullable<ChatContribution["warmup"]>;
type ScheduleDefinition = AuthorScheduleDefinition;
type ScheduleRunHandler = NonNullable<ScheduleDefinition["run"]>;
type CommandContribution = AuthorCommandContribution;
type CommandRunHandler = CommandContribution["run"];

const functionSchema = <FunctionShape extends CapabilityFunction>(
  identifier: string
): Schema.declare<FunctionShape, FunctionShape> =>
  Schema.declare<FunctionShape>(
    (value): value is FunctionShape => typeof value === "function",
    { identifier }
  );

const ChatContributionSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  start: functionSchema<ChatContribution["start"]>("ChatContribution.start"),
  stop: functionSchema<ChatContribution["stop"]>("ChatContribution.stop"),
  // See the `type` guard on CommandContributionSchema: reject any `type` field
  // so a contribution frozen against a removed contract that used a `type`
  // discriminator fails decode and is skipped, rather than decoding on the
  // fields it happens to still satisfy and crashing later. No live contract has
  // a `type`.
  type: Schema.optionalKey(Schema.Never),
  warmup: Schema.optionalKey(
    Schema.UndefinedOr(
      functionSchema<ChatWarmupHandler>("ChatContribution.warmup")
    )
  ),
});
type _ChatContributionSchemaEncodesAuthor = AssertAssignable<
  typeof ChatContributionSchema.Encoded,
  ChatContribution
>;

/**
 * Authored `schedule` named export (`feature.ts` or `schedule.ts`) (RFC 0002 schedule.md).
 * The filter enforces the one-of rule: exactly one of `markdown` or `run`.
 */
const ScheduleOverlapPolicySchema = Schema.Literals(["skip", "queue"]);

// Non-negative finite millisecond jitter bound; rejects NaN/Infinity and negatives
// at decode time so an author sees the error instead of silently clamping at runtime.
const JitterMsSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const ScheduleDefinitionSchema = Schema.Struct({
  catchUp: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  cron: Schema.NonEmptyString,
  disabled: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  jitterMs: Schema.optionalKey(Schema.UndefinedOr(JitterMsSchema)),
  markdown: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  overlap: Schema.optionalKey(Schema.UndefinedOr(ScheduleOverlapPolicySchema)),
  run: Schema.optionalKey(
    Schema.UndefinedOr(
      functionSchema<ScheduleRunHandler>("ScheduleDefinition.run")
    )
  ),
  timezone: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  // See the `type` guard on CommandContributionSchema: reject any `type` field
  // so a schedule frozen against a removed contract that used a `type`
  // discriminator fails decode and is skipped rather than crashing later. No
  // live contract has a `type`.
  type: Schema.optionalKey(Schema.Never),
}).check(
  Schema.makeFilter((value) =>
    (value.markdown !== undefined) === (value.run !== undefined)
      ? 'schedule must define exactly one of "markdown" or "run"'
      : undefined
  )
);
type _ScheduleDefinitionSchemaEncodesAuthor = AssertAssignable<
  typeof ScheduleDefinitionSchema.Encoded,
  ScheduleDefinition
>;

export const decodeScheduleDefinition = Schema.decodeUnknownEffect(
  ScheduleDefinitionSchema
);

/**
 * Frontmatter for the markdown form `schedule.md`: a required `cron`
 * plus optional `timezone`, `disabled`, and `catchUp`. The body becomes the task
 * prompt, so `.md` files are always task mode (RFC 0002 schedule.md). `disabled: true` keeps
 * the schedule loaded but unarmed, matching the `defineSchedule` form; `catchUp`
 * opts a markdown schedule into missed-fire recovery (RFC 0006 cron evaluator,
 * catch-up).
 */
export const ScheduleFrontmatterSchema = Schema.Struct({
  catchUp: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  cron: Schema.NonEmptyString,
  disabled: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  jitterMs: Schema.optionalKey(Schema.UndefinedOr(JitterMsSchema)),
  overlap: Schema.optionalKey(Schema.UndefinedOr(ScheduleOverlapPolicySchema)),
  timezone: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
});

export const decodeScheduleFrontmatter = Schema.decodeUnknownEffect(
  ScheduleFrontmatterSchema,
  {
    onExcessProperty: "error",
  }
);

/**
 * Authored `command` contribution (`feature.ts` `command`/`commands` export or a
 * standalone `command.ts`) (RFC 0002 command.md). `name` is optional here — the
 * loader defaults it from the file/feature path — but when present must be a
 * `/name`-safe slug. The argument spec generates both the `/name` parser and the
 * agent tool's input schema.
 */
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;
const CommandNameSchema = Schema.String.check(
  Schema.isPattern(COMMAND_NAME_PATTERN)
);

const CommandArgumentTypeSchema = Schema.Literals([
  "string",
  "boolean",
  "number",
]);

const CommandArgumentDefaultSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
]);

const CommandArgumentSpecSchema = Schema.Struct({
  default: Schema.optionalKey(Schema.UndefinedOr(CommandArgumentDefaultSchema)),
  description: Schema.NonEmptyString,
  positional: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  required: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  type: CommandArgumentTypeSchema,
});

const CommandArgumentsSchema = Schema.Record(
  Schema.String,
  CommandArgumentSpecSchema
);

const CommandContributionSchema = Schema.Struct({
  arguments: Schema.optionalKey(Schema.UndefinedOr(CommandArgumentsSchema)),
  description: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.UndefinedOr(CommandNameSchema)),
  run: functionSchema<CommandRunHandler>("CommandContribution.run"),
  scopes: Schema.optionalKey(
    Schema.UndefinedOr(Schema.Array(Schema.NonEmptyString))
  ),
  // The removed `commandHook` contract set `type: "commandHook"` and a
  // `run(args, ctx) => number` handler; the current contract has no `type` and
  // takes `run(ctx) => CommandResult`. A command frozen in a scaffolded
  // workspace against the old shape still satisfies `description` + a `run`
  // function, so it decoded and registered — then crashed at dispatch when the
  // router called `run(ctx)` and the old body iterated the context as its
  // `args` (`{} is not iterable`). Rejecting any `type` field fails such a
  // command at decode so the loader skips it with a diagnostic and the slash
  // falls through to a normal turn, instead of registering a command that
  // cannot run. A present `type` is impossible under the live contract.
  type: Schema.optionalKey(Schema.Never),
});
type _CommandContributionSchemaEncodesAuthor = AssertAssignable<
  typeof CommandContributionSchema.Encoded,
  CommandContribution
>;

export const decodeCommandContribution = Schema.decodeUnknownEffect(
  CommandContributionSchema
);

export {
  ChatContributionSchema,
  CommandContributionSchema,
  ScheduleDefinitionSchema,
};
export type {
  CapabilityFunction,
  StateStoreContribution,
  ChatContribution,
  CommandContribution,
  ScheduleDefinition,
};
