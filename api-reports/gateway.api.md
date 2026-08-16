# @velum-labs/routekit-gateway

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `e5efce1fa4b583dc116ccfbfbcdf74612519f27f07dd7a1bdee3b1ebbbcdb456`

## Root declarations

```ts
export type { AccountEndpointConfig, EndpointHealthProbe, EndpointHealthProbePlan, EndpointHealthResult, ModelEndpointConfig, UrlEndpointConfig } from "./endpoint-health.js";
export type { AcpAgentOptions, AcpRunner, AcpRunnerInput, AcpRunnerResult } from "./acp-agent.js";
export type { AcpRegistry, AcpRegistryAgent, InstallAcpAdaptersOptions, InstalledAcpAdapter } from "./acp-registry.js";
export type { AnthropicNativeContentBlock, AnthropicRequestMetadata, RouteKitMessageEnvelope, RouteKitReasoningEnvelope } from "./adapters/openai-chat-wire.js";
export type { AnthropicRequest, ClaudeModelSelection, ClaudePickerModelRoute } from "./adapters/anthropic.js";
export type { AnthropicSseEvent, OpenAiChatResponse, OpenAiChatSseEvent, OpenAiResponsesEvent, ProviderRecord } from "./provider-protocol.js";
export type { ApiProviderId, ApiProviderSourceOptions, DiscoveredModel, ProviderId, ProviderSource, ProviderSourceTransport, SubscriptionProviderId } from "./provider-source.js";
export type { AutoRoutingDecision, RoutingPolicyReader } from "./eval-policy.js";
export type { Backend, BackendLifecyclePort, BackendModelPort, BackendModelRoute, BackendPorts, BackendRequest, BackendRequestOptions, BackendResponseMode, BackendResponsesPort, ModelRoutedBackendOptions, RequestAttributionUpdate } from "./backend.js";
export type { BedrockControlClient, BedrockProviderSourceOptions, BedrockRuntime } from "./bedrock-source.js";
export type { CallCostRecord, ModelPricing, ProviderCostMetadata, TokenUsage } from "./cost.js";
export type { CapacityLease, CapacityPoolMember, CapacityPoolOptions, CapacityPoolStrategy } from "./capacity-pool.js";
export type { CatalogModelInfo, RoutingBackendOptions } from "./router.js";
export type { DialectName, DroppedFieldSpan } from "./adapters/dropped.js";
export type { EndpointPipeline } from "./endpoint-pipeline.js";
export type { Gateway, GatewayOptions, ModelCatalogRelay, ProviderRelayDialect, ProviderRelayPorts, RelayLifecycle, RequestRelay, TokenCountRelay } from "./server.js";
export type { GatewayDialect, ModelCallRecord, ModelGatewayCallContext, ModelGatewayCallResult, ProvenanceSink } from "./provenance.js";
export type { GatewayPrincipal, WorkloadJwtPrincipalPolicy, WorkloadJwtVerifierOptions } from "./auth.js";
export type { ModelCatalogEntry, RoutePlan } from "./routing-core.js";
export type { OpenAiBackendOptions } from "./openai-backend.js";
export type { OpenRouterModelMetadata, OpenRouterModelMetadataClientOptions, ResolvedCodexStartupSelection } from "./codex-model-selection.js";
export type { ProviderBackendOptions, ProviderTransport } from "./provider-backends.js";
export type { RequestClassifierService } from "./request-classifier.js";
export type { ResponsesRequest, ResponsesToolKind, ResponsesToolRegistry } from "./adapters/responses.js";
export type { SwitchingGatewayProxy } from "./switching-proxy.js";
export type { WebSearchDialect, WebSearchExecutor } from "./adapters/web-search.js";
export { ACP_PROTOCOL_VERSION, runAcpAgent } from "./acp-agent.js";
export { ACP_REGISTRY_URL, fetchAcpRegistry, installAcpAdapters } from "./acp-registry.js";
export { ANTHROPIC_MESSAGE_CONTENT, ANTHROPIC_REQUEST_METADATA, anthropicMessageContentOf, anthropicRequestMetadataOf, attachAnthropicMessageContent, attachAnthropicRequestMetadata, attachReasoningSelection, REASONING_SELECTION, ROUTEKIT_EXTENSION_KEY, reasoningSelectionErrorOf, reasoningSelectionOf, responsesReasoningMetadataErrorOf, routeKitRequestValidationErrorOf, withoutRouteKitExtensions } from "./adapters/openai-chat-wire.js";
export { API_PROVIDER_IDS, ApiProviderSource, decodeModelDiscovery, decodeReasoningCapabilities, PROVIDER_IDS, SUBSCRIPTION_PROVIDER_IDS } from "./provider-source.js";
export { AnthropicBackend, CodexResponsesBackend, GoogleGenAiBackend } from "./provider-backends.js";
export { AutoRoutingUnavailableError, EvalAutoRoutingForbiddenError, MissingRoutingProfileError, RoutingPolicyReadError, routingPolicyReaderFromMap, UnknownRoutingProfileError } from "./eval-policy.js";
export { BackendExecutor, ModelCatalog, ModelResolver, ProviderLifecycle, RoutePlanner, RoutePolicy } from "./routing-core.js";
export { BedrockProviderSource, fromBedrockConverseOutput, toBedrockConverseInput } from "./bedrock-source.js";
export { CapacityPool } from "./capacity-pool.js";
export { ChatStreamAssembler } from "./sse/chat-assembler.js";
export { DEFAULT_MODEL_PRICING, estimateCost, formatUsd, lookupPricing, meterCall, parseUsage, parseUsageFromSse } from "./cost.js";
export { DIALECT_DROPPED_ATTRIBUTE, droppedField, resetDroppedFieldWarnings, withDroppedFieldSpan } from "./adapters/dropped.js";
export { MAX_WEB_SEARCHES_PER_TURN, resolveWebSearchExecutor } from "./adapters/web-search.js";
export { OpenAiBackend } from "./openai-backend.js";
export { OpenRouterModelMetadataClient, resolveCodexStartupModel } from "./codex-model-selection.js";
export { anthropicModelsResponse, anthropicToChat, CLAUDE_ALIAS_PREFIX, CLAUDE_PICKER_PREFIX, chatToAnthropicMessage, claudePickerClientModel, countTokensEstimate, handleAnthropicMessages, handleCountTokens, mapStopReason, openAiSseToAnthropic, resolveClaudeModelAlias, resolveClaudeModelSelection, withClaudeReasoningSelection } from "./adapters/anthropic.js";
export { argmaxClassification, CLASSIFIABLE_PROFILE_DESCRIPTION_LIMIT, CLASSIFIABLE_PROFILE_EVIDENCE_LIMIT, CLASSIFIABLE_PROFILE_FALLBACK_LIMIT, CLASSIFIABLE_PROFILE_LIMIT, CLASSIFIABLE_REQUEST_TEXT_LIMIT, CLASSIFIER_CATALOG_TEXT_LIMIT, ClassificationError, classifiableProfilesFromPublished, classifyRequest, extractClassifiableRequestText, makeLanguageModelClassifier, makeRequestClassifierLayer, normalizeClassificationScores, parseClassifierScoreObject, RequestClassifier, validateClassifiableProfiles, validateClassificationResult } from "./request-classifier.js";
export { authorizedRequest, createWorkloadJwtVerifier, parsePrincipalHeader, presentedCredential, ROUTEKIT_PRINCIPAL_HEADER, resolvePrincipal } from "./auth.js";
export { borrowedBackendPorts, joinPath, ModelRoutedBackend, staticBackendModelPort } from "./backend.js";
export { buildModelCallRecord, MODEL_CALL_ID_HEADER, modelCallId, readProducerVersion, resolveProducerGitSha, responseBodyHash, UNKNOWN_GIT_SHA } from "./provenance.js";
export { chatToResponses, handleResponses, openAiSseToResponses, responsesToChat, responsesToolRegistry } from "./adapters/responses.js";
export { decodeAnthropicSseEvent, decodeAnthropicWebSearchResult, decodeOpenAiChatResponse, decodeOpenAiChatSseEvent, decodeOpenAiResponsesEvent, decodeOpenAiWebSearchResult, decodeToolResult, ProviderProtocolError } from "./provider-protocol.js";
export { decodeBufferedSse, SseDecoder, SseParseError } from "./sse/parse.js";
export { effectiveModel, isStream, withDefaultModel } from "./adapters/chat.js";
export { endpointHealthProbe, probeEndpointHealth, providerAuthHeaders } from "./endpoint-health.js";
export { errorEvent, finishChunk, noticeChunk, reasoningChunk, sseResponse } from "./sse-wire.js";
export { invokeObservedModelCall } from "./model-call-service.js";
export { isCursorChatBody, translateCursorRequest } from "./adapters/cursor.js";
export { isSubscriptionProvider, modelPolicyAllowsModel, modelPolicyRuleMatches, NoModelAvailableError, RoutingBackend, UnknownModelError } from "./router.js";
export { runEndpointPipeline } from "./endpoint-pipeline.js";
export { startGateway } from "./server.js";
export { startSwitchingGatewayProxy } from "./switching-proxy.js";
```
