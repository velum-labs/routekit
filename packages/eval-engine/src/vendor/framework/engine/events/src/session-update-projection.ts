import type { AcpSessionUpdate } from "../../../contracts/internal/src/acp/protocol/session-update.ts";
import type {
  RuntimeAvailableCommands,
  RuntimeConfigOption,
  RuntimeConfigOptions,
  RuntimeContentRole,
  RuntimeCurrentMode,
  RuntimeAudioContent,
  RuntimeBlobResource,
  RuntimeEmbeddedResource,
  RuntimeImageContent,
  RuntimePlan,
  RuntimeResourceLink,
  RuntimeSessionInfo,
  RuntimeTextResource,
} from "../../../contracts/internal/src/runtime/agent-session-item.ts";

type AcpSessionUpdateType = typeof AcpSessionUpdate.Type;
type AcpConfigOption = Extract<
  AcpSessionUpdateType,
  { readonly sessionUpdate: "config_option_update" }
>["configOptions"][number];
type AcpSelectOptions = Extract<
  AcpConfigOption,
  { readonly type: "select" }
>["options"];
type AcpSelectGroup = Extract<
  AcpSelectOptions[number],
  { readonly group: string }
>;
type AcpContent = Extract<
  AcpSessionUpdateType,
  {
    readonly sessionUpdate:
      | "agent_message_chunk"
      | "agent_thought_chunk"
      | "user_message_chunk";
  }
>["content"];
type ContentChunkUpdate = Extract<
  AcpSessionUpdateType,
  {
    readonly sessionUpdate:
      | "agent_message_chunk"
      | "agent_thought_chunk"
      | "user_message_chunk";
  }
>;
type AcpImageContent = Extract<AcpContent, { readonly type: "image" }>;
type AcpAudioContent = Extract<AcpContent, { readonly type: "audio" }>;
type AcpResourceLink = Extract<AcpContent, { readonly type: "resource_link" }>;
type AcpEmbeddedResource = Extract<AcpContent, { readonly type: "resource" }>;

const contentRole = (
  sessionUpdate: ContentChunkUpdate["sessionUpdate"]
): RuntimeContentRole => {
  switch (sessionUpdate) {
    case "agent_message_chunk": {
      return "assistant";
    }
    case "agent_thought_chunk": {
      return "reasoning";
    }
    case "user_message_chunk": {
      return "user";
    }
    default: {
      return sessionUpdate satisfies never;
    }
  }
};

const contentMetadata = (
  update: ContentChunkUpdate
): { readonly messageId?: string; readonly role: RuntimeContentRole } => ({
  ...(update.messageId === undefined || update.messageId === null
    ? {}
    : { messageId: update.messageId }),
  role: contentRole(update.sessionUpdate),
});

const optionalCategory = (
  value: string | null | undefined
): { readonly category?: string | undefined } =>
  value === null || value === undefined ? {} : { category: value };

const optionalDescription = (
  value: string | null | undefined
): { readonly description?: string | undefined } =>
  value === null || value === undefined ? {} : { description: value };

const isGroupOptions = (
  options: AcpSelectOptions
): options is readonly AcpSelectGroup[] =>
  options.length > 0 && options.every((entry) => "group" in entry);

const projectPlan = (
  update: Extract<AcpSessionUpdateType, { readonly sessionUpdate: "plan" }>
): RuntimePlan => ({
  entries: update.entries.map((entry) => ({
    description: entry.content,
    priority: entry.priority,
    status: entry.status,
  })),
});

const projectAvailableCommands = (
  update: Extract<
    AcpSessionUpdateType,
    { readonly sessionUpdate: "available_commands_update" }
  >
): RuntimeAvailableCommands => ({
  commands: update.availableCommands.map((command) => ({
    description: command.description,
    ...(command.input === undefined || command.input === null
      ? {}
      : { inputHint: command.input.hint }),
    name: command.name,
  })),
});

const projectCurrentMode = (
  update: Extract<
    AcpSessionUpdateType,
    { readonly sessionUpdate: "current_mode_update" }
  >
): RuntimeCurrentMode => ({
  modeId: update.currentModeId,
});

const projectConfigOption = (option: AcpConfigOption): RuntimeConfigOption => {
  if (option.type === "boolean") {
    return {
      ...optionalCategory(option.category),
      currentValue: option.currentValue,
      ...optionalDescription(option.description),
      id: option.id,
      label: option.name,
      type: "boolean",
    };
  }
  const options = isGroupOptions(option.options)
    ? option.options.map((group) => ({
        id: group.group,
        label: group.name,
        options: group.options.map((selectOption) => ({
          ...optionalDescription(selectOption.description),
          label: selectOption.name,
          value: selectOption.value,
        })),
      }))
    : option.options.map((selectOption) => ({
        ...optionalDescription(selectOption.description),
        label: selectOption.name,
        value: selectOption.value,
      }));
  return {
    ...optionalCategory(option.category),
    currentValue: option.currentValue,
    ...optionalDescription(option.description),
    id: option.id,
    label: option.name,
    options,
    type: "select",
  };
};

const projectConfigOptions = (
  update: Extract<
    AcpSessionUpdateType,
    { readonly sessionUpdate: "config_option_update" }
  >
): RuntimeConfigOptions => ({
  options: update.configOptions.map(projectConfigOption),
});

const projectSessionInfo = (
  update: Extract<
    AcpSessionUpdateType,
    { readonly sessionUpdate: "session_info_update" }
  >
): RuntimeSessionInfo => ({
  ...(update.title === undefined ? {} : { title: update.title }),
  ...(update.updatedAt === undefined ? {} : { updatedAt: update.updatedAt }),
});

const projectImageContent = (
  content: AcpImageContent,
  metadata: ReturnType<typeof contentMetadata>
): RuntimeImageContent => ({
  ...metadata,
  data: content.data,
  mimeType: content.mimeType,
  ...(content.uri === undefined || content.uri === null
    ? {}
    : { uri: content.uri }),
});

const projectAudioContent = (
  content: AcpAudioContent,
  metadata: ReturnType<typeof contentMetadata>
): RuntimeAudioContent => ({
  ...metadata,
  data: content.data,
  mimeType: content.mimeType,
});

const projectResourceLink = (
  content: AcpResourceLink,
  metadata: ReturnType<typeof contentMetadata>
): RuntimeResourceLink => ({
  ...metadata,
  ...(content.description === undefined || content.description === null
    ? {}
    : { description: content.description }),
  ...(content.mimeType === undefined || content.mimeType === null
    ? {}
    : { mimeType: content.mimeType }),
  name: content.name,
  ...(content.size === undefined || content.size === null
    ? {}
    : { size: content.size }),
  ...(content.title === undefined || content.title === null
    ? {}
    : { title: content.title }),
  uri: content.uri,
});

const projectEmbeddedResource = (
  content: AcpEmbeddedResource,
  metadata: ReturnType<typeof contentMetadata>
): RuntimeEmbeddedResource => ({
  resource:
    "text" in content.resource
      ? ({
          ...metadata,
          ...(content.resource.mimeType === undefined ||
          content.resource.mimeType === null
            ? {}
            : { mimeType: content.resource.mimeType }),
          text: content.resource.text,
          uri: content.resource.uri,
        } satisfies RuntimeTextResource)
      : ({
          ...metadata,
          blob: content.resource.blob,
          ...(content.resource.mimeType === undefined ||
          content.resource.mimeType === null
            ? {}
            : { mimeType: content.resource.mimeType }),
          uri: content.resource.uri,
        } satisfies RuntimeBlobResource),
});

const projectContentItem = (
  update: ContentChunkUpdate
): {
  readonly itemType: "audio" | "image" | "resource" | "resource_link";
  readonly data: unknown;
} => {
  if (update.content.type === "text") {
    throw new Error("Text content must use the delta projection");
  }
  const metadata = contentMetadata(update);
  switch (update.content.type) {
    case "audio": {
      return {
        data: projectAudioContent(update.content, metadata),
        itemType: "audio",
      };
    }
    case "image": {
      return {
        data: projectImageContent(update.content, metadata),
        itemType: "image",
      };
    }
    case "resource": {
      return {
        data: projectEmbeddedResource(update.content, metadata),
        itemType: "resource",
      };
    }
    case "resource_link": {
      return {
        data: projectResourceLink(update.content, metadata),
        itemType: "resource_link",
      };
    }
    default: {
      return update.content satisfies never;
    }
  }
};

export {
  projectAvailableCommands,
  projectConfigOptions,
  projectCurrentMode,
  projectContentItem,
  projectPlan,
  projectSessionInfo,
};
