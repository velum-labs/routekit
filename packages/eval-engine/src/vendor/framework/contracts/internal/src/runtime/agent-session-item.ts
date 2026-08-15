import { Schema } from "effect";

import { RuntimeUsageSchema } from "./agent-runtime-event.ts";
import { NonNegativeInt } from "./schema-primitives.ts";

const RuntimePlanEntry = Schema.Struct({
  description: Schema.String,
  priority: Schema.Literals(["high", "medium", "low"]),
  status: Schema.Literals(["pending", "in_progress", "completed"]),
}).annotate({ identifier: "RuntimePlanEntry" });

const RuntimePlan = Schema.Struct({
  entries: Schema.Array(RuntimePlanEntry),
}).annotate({ identifier: "RuntimePlan" });

const RuntimeAvailableCommand = Schema.Struct({
  description: Schema.String,
  inputHint: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  name: Schema.String,
}).annotate({ identifier: "RuntimeAvailableCommand" });

const RuntimeAvailableCommands = Schema.Struct({
  commands: Schema.Array(RuntimeAvailableCommand),
}).annotate({ identifier: "RuntimeAvailableCommands" });

const RuntimeCurrentMode = Schema.Struct({
  modeId: Schema.String,
}).annotate({ identifier: "RuntimeCurrentMode" });

const RuntimeConfigSelectOption = Schema.Struct({
  description: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  label: Schema.String,
  value: Schema.String,
}).annotate({ identifier: "RuntimeConfigSelectOption" });

const RuntimeConfigSelectGroup = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  options: Schema.Array(RuntimeConfigSelectOption),
}).annotate({ identifier: "RuntimeConfigSelectGroup" });

const RuntimeConfigSelect = Schema.Struct({
  category: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  currentValue: Schema.String,
  description: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  id: Schema.String,
  label: Schema.String,
  options: Schema.Union([
    Schema.Array(RuntimeConfigSelectOption),
    Schema.Array(RuntimeConfigSelectGroup),
  ]),
  type: Schema.Literal("select"),
}).annotate({ identifier: "RuntimeConfigSelect" });

const RuntimeConfigBoolean = Schema.Struct({
  category: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  currentValue: Schema.Boolean,
  description: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  id: Schema.String,
  label: Schema.String,
  type: Schema.Literal("boolean"),
}).annotate({ identifier: "RuntimeConfigBoolean" });

const RuntimeConfigOption = Schema.Union([
  RuntimeConfigSelect,
  RuntimeConfigBoolean,
])
  .annotate({ identifier: "RuntimeConfigOption" })
  .pipe(Schema.toTaggedUnion("type"));

const RuntimeConfigOptions = Schema.Struct({
  options: Schema.Array(RuntimeConfigOption),
}).annotate({ identifier: "RuntimeConfigOptions" });

const RuntimeSessionInfo = Schema.Struct({
  title: Schema.optionalKey(Schema.UndefinedOr(Schema.NullOr(Schema.String))),
  updatedAt: Schema.optionalKey(
    Schema.UndefinedOr(Schema.NullOr(Schema.String))
  ),
}).annotate({ identifier: "RuntimeSessionInfo" });

const RuntimeContentRole = Schema.Literals([
  "assistant",
  "reasoning",
  "user",
]).annotate({ identifier: "RuntimeContentRole" });

const RuntimeImageContent = Schema.Struct({
  data: Schema.String,
  mimeType: Schema.String,
  messageId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  role: RuntimeContentRole,
  uri: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
}).annotate({ identifier: "RuntimeImageContent" });

const RuntimeAudioContent = Schema.Struct({
  data: Schema.String,
  mimeType: Schema.String,
  messageId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  role: RuntimeContentRole,
}).annotate({ identifier: "RuntimeAudioContent" });

const RuntimeResourceLink = Schema.Struct({
  description: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  messageId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  mimeType: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  name: Schema.String,
  role: RuntimeContentRole,
  size: Schema.optionalKey(Schema.UndefinedOr(NonNegativeInt)),
  title: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  uri: Schema.String,
}).annotate({ identifier: "RuntimeResourceLink" });

const RuntimeTextResource = Schema.Struct({
  messageId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  mimeType: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  role: RuntimeContentRole,
  text: Schema.String,
  uri: Schema.String,
}).annotate({ identifier: "RuntimeTextResource" });

const RuntimeBlobResource = Schema.Struct({
  blob: Schema.String,
  messageId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  mimeType: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  role: RuntimeContentRole,
  uri: Schema.String,
}).annotate({ identifier: "RuntimeBlobResource" });

const RuntimeEmbeddedResource = Schema.Struct({
  resource: Schema.Union([RuntimeTextResource, RuntimeBlobResource]),
}).annotate({ identifier: "RuntimeEmbeddedResource" });

const RuntimeUsageReport = Schema.Struct({
  contextTokens: NonNegativeInt,
  contextWindow: Schema.optionalKey(Schema.UndefinedOr(NonNegativeInt)),
  // This cumulative figure must not be summed with attribution's per-message cost.
  cumulativeCostUsd: Schema.optionalKey(Schema.UndefinedOr(Schema.Finite)),
  usage: Schema.optionalKey(Schema.UndefinedOr(RuntimeUsageSchema)),
}).annotate({ identifier: "RuntimeUsageReport" });

const RuntimeAgentSessionItemType = Schema.Literals([
  "available_commands",
  "audio",
  "config_options",
  "current_mode",
  "image",
  "plan",
  "resource",
  "resource_link",
  "session_info",
  "usage",
]);
const RuntimeUsageItemType = "usage" as const;

export {
  RuntimeAgentSessionItemType,
  RuntimeAudioContent,
  RuntimeAvailableCommand,
  RuntimeAvailableCommands,
  RuntimeConfigBoolean,
  RuntimeConfigOption,
  RuntimeConfigOptions,
  RuntimeConfigSelect,
  RuntimeConfigSelectGroup,
  RuntimeConfigSelectOption,
  RuntimeContentRole,
  RuntimeCurrentMode,
  RuntimeBlobResource,
  RuntimeEmbeddedResource,
  RuntimeImageContent,
  RuntimePlan,
  RuntimePlanEntry,
  RuntimeResourceLink,
  RuntimeSessionInfo,
  RuntimeTextResource,
  RuntimeUsageItemType,
  RuntimeUsageReport,
};
export type RuntimeAgentSessionItemType =
  typeof RuntimeAgentSessionItemType.Type;
export type RuntimeAvailableCommand = typeof RuntimeAvailableCommand.Type;
export type RuntimeAvailableCommands = typeof RuntimeAvailableCommands.Type;
export type RuntimeAudioContent = typeof RuntimeAudioContent.Type;
export type RuntimeBlobResource = typeof RuntimeBlobResource.Type;
export type RuntimeConfigOption = typeof RuntimeConfigOption.Type;
export type RuntimeConfigOptions = typeof RuntimeConfigOptions.Type;
export type RuntimeConfigSelect = typeof RuntimeConfigSelect.Type;
export type RuntimeConfigSelectGroup = typeof RuntimeConfigSelectGroup.Type;
export type RuntimeConfigSelectOption = typeof RuntimeConfigSelectOption.Type;
export type RuntimeContentRole = typeof RuntimeContentRole.Type;
export type RuntimeCurrentMode = typeof RuntimeCurrentMode.Type;
export type RuntimeEmbeddedResource = typeof RuntimeEmbeddedResource.Type;
export type RuntimeImageContent = typeof RuntimeImageContent.Type;
export type RuntimePlan = typeof RuntimePlan.Type;
export type RuntimeResourceLink = typeof RuntimeResourceLink.Type;
export type RuntimePlanEntry = typeof RuntimePlanEntry.Type;
export type RuntimeSessionInfo = typeof RuntimeSessionInfo.Type;
export type RuntimeTextResource = typeof RuntimeTextResource.Type;
export type RuntimeUsageItemType = typeof RuntimeUsageItemType;
export type RuntimeUsageReport = typeof RuntimeUsageReport.Type;
