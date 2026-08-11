# @velum-labs/routekit-gateway/protocol

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `4de331ce2388b615b4791c911b35df7aeb7d02cc999316ad0cf9457773b16063`

## Root declarations

```ts
export type { AnthropicSseEvent, GoogleGenerateContent, ModelCatalogEntry, ModelCatalogPayload, OpenAiChatResponse, OpenAiChatSseEvent, OpenAiResponsesEvent, ProviderRecord } from "./provider-protocol.js";
export type { Citation, ContentPart, Conversation, ConversationMessage, ExtensionField, Reasoning, ToolCall, ToolResult, Usage } from "./protocol-ir.js";
export type { SseTransformOptions } from "./sse/stream-pump.js";
export { SseTransform, StreamPump } from "./sse/stream-pump.js";
export { conversationFromOpenAiMessages, conversationText } from "./protocol-ir.js";
export { decodeAnthropicSseEvent, decodeAnthropicWebSearchResult, decodeGoogleGenerateContent, decodeModelCatalogPayload, decodeModelDiscoveryPayload, decodeOpenAiChatResponse, decodeOpenAiChatSseEvent, decodeOpenAiResponsesEvent, decodeOpenAiToolCalls, decodeOpenAiWebSearchResult, decodeProviderJson, decodeToolResult, isProviderRecord, ProviderProtocolError } from "./provider-protocol.js";
```
