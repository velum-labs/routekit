/**
 * Provider-neutral protocol representation.
 *
 * Provider codecs decode into this representation before application logic
 * consumes the payload. Extensions are deliberately typed and namespaced:
 * provider-specific data must never be smuggled into a provider-neutral field.
 */
export type ExtensionField<Namespace extends string = string, Value = unknown> = Readonly<{
  namespace: Namespace;
  value: Value;
}>;

export type Citation = Readonly<{
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
  extensions?: readonly ExtensionField[];
}>;

export type AnthropicReasoningExtension = ExtensionField<
  "anthropic.reasoning",
  Readonly<{
    index: number;
    phase?: "start" | "delta" | "signature" | "stop" | "block";
    signature?: string;
    redacted?: boolean;
  }>
>;

export type GoogleReasoningExtension = ExtensionField<
  "google.reasoning",
  Readonly<{ index: number; thoughtSignature: string }>
>;

export type ResponsesReasoningExtension = ExtensionField<
  "openai.responses.reasoning",
  Readonly<{ id?: string; summary?: unknown; content?: unknown }>
>;

export type Reasoning = Readonly<{
  text?: string;
  summary?: string;
  encryptedContent?: string;
  extensions?: readonly (
    | AnthropicReasoningExtension
    | GoogleReasoningExtension
    | ResponsesReasoningExtension
    | ExtensionField
  )[];
}>;

export type ToolCall = Readonly<{
  id: string;
  name: string;
  arguments: unknown;
  execution: "client" | "server";
  extensions?: readonly ExtensionField[];
}>;

export type ToolCallAssemblyExtension = ExtensionField<
  "routekit.tool-call-assembly",
  Readonly<{ index?: number; providerIndex?: number }>
>;

export type ToolResult = Readonly<{
  toolCallId?: string;
  content: string;
  isError: boolean;
  citations: readonly Citation[];
  extensions?: readonly ExtensionField[];
}>;

export type ContentPart =
  | Readonly<{ type: "text"; text: string; citations?: readonly Citation[] }>
  | Readonly<{ type: "image"; url: string; mediaType?: string }>
  | Readonly<{ type: "reasoning"; reasoning: Reasoning }>
  | Readonly<{ type: "tool_call"; call: ToolCall }>
  | Readonly<{ type: "tool_result"; result: ToolResult }>;

export type ConversationMessage = Readonly<{
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: readonly ContentPart[];
  extensions?: readonly ExtensionField[];
}>;

export type Conversation = Readonly<{
  messages: readonly ConversationMessage[];
  extensions?: readonly ExtensionField[];
}>;

export type Usage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  extensions?: readonly ExtensionField[];
}>;

export type OpenAiUsageExtension = ExtensionField<
  "openai.chat.usage-details",
  Readonly<{
    promptTokens?: Readonly<Record<string, unknown>>;
    completionTokens?: Readonly<Record<string, unknown>>;
  }>
>;

export function extensionValue<Namespace extends string, Value>(
  extensions: readonly ExtensionField[] | undefined,
  namespace: Namespace
): Value | undefined {
  return extensions?.find((extension) => extension.namespace === namespace)?.value as
    | Value
    | undefined;
}

export function conversationFromOpenAiMessages(
  messages: readonly Readonly<{
    role?: string;
    content?: unknown;
    tool_call_id?: string;
  }>[]
): Conversation {
  return {
    messages: messages.flatMap((message): ConversationMessage[] => {
      if (
        message.role !== "system" &&
        message.role !== "developer" &&
        message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "tool"
      ) {
        return [];
      }
      const content: ContentPart[] =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : Array.isArray(message.content)
            ? message.content.flatMap((part): ContentPart[] => {
                if (
                  typeof part === "object" &&
                  part !== null &&
                  "text" in part &&
                  typeof part.text === "string"
                ) {
                  return [{ type: "text", text: part.text }];
                }
                return [];
              })
            : [];
      if (message.role === "tool") {
        return [
          {
            role: "tool",
            content: [
              {
                type: "tool_result",
                result: {
                  ...(message.tool_call_id !== undefined
                    ? { toolCallId: message.tool_call_id }
                    : {}),
                  content: content
                    .flatMap((part) => (part.type === "text" ? [part.text] : []))
                    .join(""),
                  isError: false,
                  citations: []
                }
              }
            ]
          }
        ];
      }
      return [{ role: message.role, content }];
    })
  };
}

export function conversationText(message: ConversationMessage): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
