# @velum-labs/routekit-gateway

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `a6de41a198cf317d14d7caeb8a576aea831f687fce8f1747655f60ec435d871e`

## Root declarations

```ts
export type { AccountEndpointConfig, EndpointHealthProbe, EndpointHealthProbePlan, EndpointHealthResult, ModelEndpointConfig, UrlEndpointConfig } from "./services/endpoint-health/service.js";
export type { AcpAgentOptions, AcpRunner, AcpRunnerInput, AcpRunnerResult } from "./acp/agent.js";
export type { AcpRegistry, AcpRegistryAgent, InstallAcpAdaptersOptions, InstalledAcpAdapter } from "./acp/registry.js";
export type { AnthropicNativeContentBlock, AnthropicRequestMetadata, RouteKitMessageEnvelope, RouteKitReasoningEnvelope } from "./adapters/openai-chat-wire.js";
export type { AnthropicRequest, ClaudeModelSelection, ClaudePickerModelRoute } from "./adapters/anthropic.js";
export type { AnthropicSseEvent, OpenAiChatResponse, OpenAiChatSseEvent, OpenAiResponsesEvent, ProviderRecord } from "./providers/protocol.js";
export type { ApiProviderId, ApiProviderSourceOptions, DiscoveredModel, ProviderId, ProviderSource, ProviderSourceTransport, SubscriptionProviderId } from "./providers/source.js";
export type { Backend, BackendLifecyclePort, BackendModelPort, BackendModelRoute, BackendPorts, BackendRequest, BackendRequestOptions, BackendResponseMode, BackendResponsesPort, ModelRoutedBackendOptions, RequestAttributionUpdate } from "./providers/backend.js";
export type { BedrockControlClient, BedrockProviderSourceOptions, BedrockRuntime } from "./providers/bedrock-source.js";
export type { CallCostRecord, ModelPricing, ProviderCostMetadata, TokenUsage } from "./observability/cost.js";
export type { CapacityLease, CapacityPoolMember, CapacityPoolOptions, CapacityPoolStrategy } from "./capacity-pool.js";
export type { CatalogModelInfo, RoutingBackendOptions } from "./routing/router.js";
export type { CompositionalRoutingErrorCode, CompositionalRoutingInput } from "./routing/compositional.js";
export type { CompositionalRoutingObservation, CompositionalRoutingPolicyReader, CompositionalRoutingRuntime } from "./routing/eval-policy.js";
export type { DialectName, DroppedFieldSpan } from "./adapters/dropped.js";
export type { EndpointPipeline } from "./endpoint-pipeline.js";
export type { EvalSessionAdmission, GatewayPrincipal, WorkloadJwtPrincipalPolicy, WorkloadJwtVerifierOptions } from "./http/auth.js";
export type { Gateway, GatewayOptions, ModelCatalogRelay, ProviderRelayDialect, ProviderRelayPorts, RelayLifecycle, RequestRelay, TokenCountRelay } from "./services/gateway/service.js";
export type { GatewayDialect, ModelCallRecord, ModelGatewayCallContext, ModelGatewayCallResult, ProvenanceSink } from "./observability/provenance.js";
export type { ModelCatalogEntry, RoutePlan } from "./routing/core.js";
export type { ObservedDecompositionResult, RequestDecomposerService } from "./services/request-classifier/service.js";
export type { OpenAiBackendOptions } from "./providers/openai-backend.js";
export type { OpenRouterModelMetadata, OpenRouterModelMetadataClientOptions, ResolvedCodexStartupSelection } from "./providers/codex-model-selection.js";
export type { ProviderBackendOptions, ProviderTransport } from "./providers/backends.js";
export type { ResponsesRequest, ResponsesToolKind, ResponsesToolRegistry } from "./adapters/responses.js";
export type { SwitchingGatewayProxy } from "./services/switching-proxy/service.js";
export type { WebSearchDialect, WebSearchExecutor } from "./adapters/web-search.js";
export { ACP_PROTOCOL_VERSION, runAcpAgent } from "./acp/agent.js";
export { ACP_REGISTRY_URL, fetchAcpRegistry, installAcpAdapters } from "./acp/registry.js";
export { ANTHROPIC_MESSAGE_CONTENT, ANTHROPIC_REQUEST_METADATA, anthropicMessageContentOf, anthropicRequestMetadataOf, attachAnthropicMessageContent, attachAnthropicRequestMetadata, attachReasoningSelection, REASONING_SELECTION, ROUTEKIT_EXTENSION_KEY, reasoningSelectionErrorOf, reasoningSelectionOf, responsesReasoningMetadataErrorOf, routeKitRequestValidationErrorOf, withoutRouteKitExtensions } from "./adapters/openai-chat-wire.js";
export { API_PROVIDER_IDS, ApiProviderSource, decodeModelDiscovery, decodeReasoningCapabilities, PROVIDER_IDS, SUBSCRIPTION_PROVIDER_IDS } from "./providers/source.js";
export { AnthropicBackend, CodexResponsesBackend, GoogleGenAiBackend } from "./providers/backends.js";
export { AutoRoutingUnavailableError, compositionalRoutingAttribution, compositionalRoutingPolicyReaderFromSnapshot, EvalAutoRoutingForbiddenError, RoutingPolicyReadError, resolveCompositionalAutoRoutingModel, resolveConfiguredAutoRoutingModel } from "./routing/eval-policy.js";
export { BackendExecutor, ModelCatalog, ModelResolver, ProviderLifecycle, RoutePlanner, RoutePolicy } from "./routing/core.js";
export { BedrockProviderSource, fromBedrockConverseOutput, toBedrockConverseInput } from "./providers/bedrock-source.js";
export { CLASSIFIABLE_REQUEST_TEXT_LIMIT, ClassificationError, classifyRequestDimensions, extractClassifiableRequestText, makeFakeRequestDecomposer, makeLanguageModelDimensionClassifier, makeRequestDecomposerLayer, parseDecompositionResult, RequestDecomposer, validateDecompositionInput, validateDecompositionResult } from "./services/request-classifier/service.js";
export { CapacityPool } from "./capacity-pool.js";
export { ChatStreamAssembler } from "./sse/chat-assembler.js";
export { CompositionalRoutingError, routeCompositionalRequest } from "./routing/compositional.js";
export { DEFAULT_MODEL_PRICING, estimateCost, formatUsd, lookupPricing, meterCall, parseUsage, parseUsageFromSse } from "./observability/cost.js";
export { DIALECT_DROPPED_ATTRIBUTE, droppedField, resetDroppedFieldWarnings, withDroppedFieldSpan } from "./adapters/dropped.js";
export { MAX_WEB_SEARCHES_PER_TURN, resolveWebSearchExecutor } from "./adapters/web-search.js";
export { OpenAiBackend } from "./providers/openai-backend.js";
export { OpenRouterModelMetadataClient, resolveCodexStartupModel } from "./providers/codex-model-selection.js";
export { anthropicModelsResponse, anthropicToChat, CLAUDE_ALIAS_PREFIX, CLAUDE_PICKER_PREFIX, chatToAnthropicMessage, claudePickerClientModel, countTokensEstimate, handleAnthropicMessages, handleCountTokens, mapStopReason, openAiSseToAnthropic, resolveClaudeModelAlias, resolveClaudeModelSelection, withClaudeReasoningSelection } from "./adapters/anthropic.js";
export { authorizedRequest, createWorkloadJwtVerifier, parsePrincipalHeader, presentedCredential, ROUTEKIT_PRINCIPAL_HEADER, resolvePrincipal } from "./http/auth.js";
export { borrowedBackendPorts, joinPath, ModelRoutedBackend, staticBackendModelPort } from "./providers/backend.js";
export { buildModelCallRecord, MODEL_CALL_ID_HEADER, modelCallId, readProducerVersion, resolveProducerGitSha, responseBodyHash, UNKNOWN_GIT_SHA } from "./observability/provenance.js";
export { chatToResponses, handleResponses, openAiSseToResponses, responsesToChat, responsesToolRegistry } from "./adapters/responses.js";
export { decodeAnthropicSseEvent, decodeAnthropicWebSearchResult, decodeOpenAiChatResponse, decodeOpenAiChatSseEvent, decodeOpenAiResponsesEvent, decodeOpenAiWebSearchResult, decodeToolResult, ProviderProtocolError } from "./providers/protocol.js";
export { decodeBufferedSse, SseDecoder, SseParseError } from "./sse/parse.js";
export { deriveRoutingRequirements, routingModelAvailability } from "./routing/requirements.js";
export { effectiveModel, isStream, withDefaultModel } from "./adapters/chat.js";
export { endpointHealthProbe, probeEndpointHealth, providerAuthHeaders } from "./services/endpoint-health/service.js";
export { errorEvent, finishChunk, noticeChunk, reasoningChunk, sseResponse } from "./sse/wire.js";
export { invokeObservedModelCall } from "./services/model-call/service.js";
export { isCursorChatBody, translateCursorRequest } from "./adapters/cursor.js";
export { isSubscriptionProvider, modelPolicyAllowsModel, modelPolicyRuleMatches, NoModelAvailableError, RoutingBackend, UnknownModelError } from "./routing/router.js";
export { runEndpointPipeline } from "./endpoint-pipeline.js";
export { startGateway } from "./services/gateway/service.js";
export { startSwitchingGatewayProxy } from "./services/switching-proxy/service.js";
```
