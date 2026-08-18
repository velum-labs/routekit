# @velum-labs/routekit-gateway/protocol

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `345baf6efb4e5b07d12d5c2fa9cbddb7852887f583e37bb2db90911e436ff188`

## Root declarations

```ts
export type { AnthropicSseEvent, GoogleGenerateContent, ModelCatalogEntry, ModelCatalogPayload, OpenAiChatResponse, OpenAiChatSseEvent, OpenAiResponsesEvent, ProviderRecord } from "./providers/protocol.js";
export { decodeAnthropicSseEvent, decodeAnthropicWebSearchResult, decodeGoogleGenerateContent, decodeModelCatalogPayload, decodeOpenAiChatResponse, decodeOpenAiChatSseEvent, decodeOpenAiResponsesEvent, decodeOpenAiToolCalls, decodeOpenAiWebSearchResult, decodeProviderJson, decodeToolResult, isProviderRecord, ProviderProtocolError } from "./providers/protocol.js";
```
