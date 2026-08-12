# @velum-labs/routekit-gateway/protocol

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `51319d935e03ce3aa3d66b15823f5ce4bcfbb22321e8abafbb6962f14cd765f6`

## Root declarations

```ts
export type { AnthropicSseEvent, GoogleGenerateContent, ModelCatalogEntry, ModelCatalogPayload, OpenAiChatResponse, OpenAiChatSseEvent, OpenAiResponsesEvent, ProviderRecord } from "./provider-protocol.js";
export { decodeAnthropicSseEvent, decodeAnthropicWebSearchResult, decodeGoogleGenerateContent, decodeModelCatalogPayload, decodeOpenAiChatResponse, decodeOpenAiChatSseEvent, decodeOpenAiResponsesEvent, decodeOpenAiToolCalls, decodeOpenAiWebSearchResult, decodeProviderJson, decodeToolResult, isProviderRecord, ProviderProtocolError } from "./provider-protocol.js";
```
