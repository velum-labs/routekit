/** Product-neutral RouteKit gateway and router. */
export { startGateway } from "./server.js";
export { runEndpointPipeline } from "./endpoint-pipeline.js";
export type { EndpointPipeline } from "./endpoint-pipeline.js";
export type {
  Gateway,
  GatewayOptions,
  ModelCatalogRelay,
  ProviderRelayDialect,
  ProviderRelayPorts,
  RelayLifecycle,
  RequestRelay,
  TokenCountRelay
} from "./server.js";
export { startSwitchingGatewayProxy } from "./switching-proxy.js";
export type { SwitchingGatewayProxy } from "./switching-proxy.js";

export {
  backendPorts,
  defineBackendPorts,
  joinPath,
  ModelRoutedBackend,
  OpenAiBackend,
  staticBackendModelPort
} from "./backend.js";
export type {
  Backend,
  BackendLifecyclePort,
  BackendModelPort,
  BackendModelRoute,
  BackendPorts,
  BackendRequestOptions,
  BackendResponsesPort,
  BackendResponseMode,
  RequestAttributionUpdate,
  ModelRoutedBackendOptions,
  OpenAiBackendOptions
} from "./backend.js";

export {
  AnthropicBackend,
  CodexResponsesBackend,
  GoogleGenAiBackend
} from "./provider-backends.js";
export type { ProviderBackendOptions, ProviderTransport } from "./provider-backends.js";
export {
  BedrockProviderSource,
  fromBedrockConverseOutput,
  toBedrockConverseInput
} from "./bedrock-source.js";
export type {
  BedrockControlClient,
  BedrockProviderSourceOptions,
  BedrockRuntime
} from "./bedrock-source.js";

export {
  RoutingBackend,
  isSubscriptionProvider,
  NoModelAvailableError,
  modelPolicyAllowsModel,
  modelPolicyRuleMatches,
  UnknownModelError
} from "./router.js";
export type { RoutingBackendOptions, CatalogModelInfo } from "./router.js";
export {
  BackendExecutor,
  ModelCatalog,
  ModelResolver,
  ProviderLifecycle,
  RoutePlanner,
  RoutePolicy
} from "./routing-core.js";
export type { ModelCatalogEntry, RoutePlan } from "./routing-core.js";
export {
  API_PROVIDER_IDS,
  ApiProviderSource,
  parseDiscoveredModels,
  parseReasoningCapabilities,
  PROVIDER_IDS,
  SUBSCRIPTION_PROVIDER_IDS
} from "./provider-source.js";
export {
  OpenRouterModelMetadataClient,
  resolveCodexStartupModel
} from "./codex-model-selection.js";
export type {
  OpenRouterModelMetadata,
  OpenRouterModelMetadataClientOptions,
  ResolvedCodexStartupSelection
} from "./codex-model-selection.js";
export type {
  ApiProviderId,
  ApiProviderSourceOptions,
  DiscoveredModel,
  ProviderId,
  ProviderSource,
  ProviderSourceTransport,
  SubscriptionProviderId
} from "./provider-source.js";
export {
  endpointHealthProbe,
  probeEndpointHealth,
  providerAuthHeaders
} from "./endpoint-health.js";
export type {
  AccountEndpointConfig,
  EndpointHealthProbe,
  EndpointHealthProbePlan,
  EndpointHealthResult,
  ModelEndpointConfig,
  UrlEndpointConfig
} from "./endpoint-health.js";

export { CapacityPool } from "./capacity-pool.js";
export type {
  CapacityLease,
  CapacityPoolMember,
  CapacityPoolOptions,
  CapacityPoolStrategy
} from "./capacity-pool.js";

export { effectiveModel, isStream, withDefaultModel } from "./adapters/chat.js";
export {
  ANTHROPIC_MESSAGE_CONTENT,
  ANTHROPIC_REQUEST_METADATA,
  REASONING_SELECTION,
  ROUTEKIT_EXTENSION_KEY,
  attachAnthropicMessageContent,
  attachAnthropicRequestMetadata,
  attachReasoningSelection,
  anthropicMessageContentOf,
  anthropicRequestMetadataOf,
  routeKitRequestValidationErrorOf,
  reasoningSelectionErrorOf,
  reasoningSelectionOf,
  responsesReasoningMetadataErrorOf,
  withoutRouteKitExtensions
} from "./adapters/openai-chat-wire.js";
export type {
  AnthropicNativeContentBlock,
  AnthropicRequestMetadata,
  RouteKitMessageEnvelope,
  RouteKitReasoningEnvelope
} from "./adapters/openai-chat-wire.js";
export { isCursorChatBody, translateCursorRequest } from "./adapters/cursor.js";
export {
  anthropicModelsResponse,
  anthropicToChat,
  CLAUDE_ALIAS_PREFIX,
  CLAUDE_PICKER_PREFIX,
  chatToAnthropicMessage,
  claudePickerClientModel,
  countTokensEstimate,
  handleAnthropicMessages,
  handleCountTokens,
  mapStopReason,
  openAiSseToAnthropic,
  resolveClaudeModelAlias,
  resolveClaudeModelSelection,
  withClaudeReasoningSelection
} from "./adapters/anthropic.js";
export type {
  AnthropicRequest,
  ClaudeModelSelection,
  ClaudePickerModelRoute
} from "./adapters/anthropic.js";
export {
  chatToResponses,
  handleResponses,
  openAiSseToResponses,
  responsesToChat,
  responsesToolRegistry
} from "./adapters/responses.js";
export type {
  ResponsesRequest,
  ResponsesToolKind,
  ResponsesToolRegistry
} from "./adapters/responses.js";
export { ProviderProtocolError } from "./provider-protocol.js";
export {
  decodeAnthropicSseEvent,
  decodeAnthropicWebSearchResult,
  decodeModelDiscoveryPayload,
  decodeOpenAiChatResponse,
  decodeOpenAiChatSseEvent,
  decodeOpenAiResponsesEvent,
  decodeOpenAiWebSearchResult,
  decodeToolResult
} from "./provider-protocol.js";
export type {
  AnthropicSseEvent,
  OpenAiChatResponse,
  OpenAiChatSseEvent,
  OpenAiResponsesEvent,
  ProviderRecord
} from "./provider-protocol.js";
export { SseTransform, StreamPump } from "./sse/stream-pump.js";
export type { SseTransformOptions } from "./sse/stream-pump.js";
export type {
  Citation,
  ContentPart,
  Conversation,
  ConversationMessage,
  ExtensionField,
  Reasoning,
  ToolCall,
  ToolResult,
  Usage
} from "./protocol-ir.js";
export { MAX_WEB_SEARCHES_PER_TURN, resolveWebSearchExecutor } from "./adapters/web-search.js";
export type { WebSearchDialect, WebSearchExecutor } from "./adapters/web-search.js";
export {
  DIALECT_DROPPED_ATTRIBUTE,
  droppedField,
  resetDroppedFieldWarnings,
  withDroppedFieldSpan
} from "./adapters/dropped.js";
export type { DialectName, DroppedFieldSpan } from "./adapters/dropped.js";

export { ACP_PROTOCOL_VERSION, runAcpAgent } from "./acp-agent.js";
export type {
  AcpAgentOptions,
  AcpRunner,
  AcpRunnerInput,
  AcpRunnerResult
} from "./acp-agent.js";
export {
  ACP_REGISTRY_URL,
  fetchAcpRegistry,
  installAcpAdapters
} from "./acp-registry.js";
export type {
  AcpRegistry,
  AcpRegistryAgent,
  AcpRegistryFetcher,
  InstallAcpAdaptersOptions,
  InstalledAcpAdapter
} from "./acp-registry.js";

export {
  DEFAULT_MODEL_PRICING,
  estimateCost,
  formatUsd,
  lookupPricing,
  meterCall,
  parseUsage,
  parseUsageFromSse
} from "./cost.js";
export type {
  CallCostRecord,
  ModelPricing,
  ProviderCostMetadata,
  TokenUsage
} from "./cost.js";

export {
  buildModelCallRecord,
  MODEL_CALL_ID_HEADER,
  modelCallId,
  readProducerVersion,
  resolveProducerGitSha,
  responseBodyHash,
  UNKNOWN_GIT_SHA
} from "./provenance.js";
export type {
  GatewayDialect,
  ModelCallRecord,
  ModelGatewayCallContext,
  ModelGatewayCallResult,
  ProvenanceSink
} from "./provenance.js";

export {
  authorizedRequest,
  createWorkloadJwtVerifier,
  parsePrincipalHeader,
  presentedCredential,
  resolvePrincipal,
  ROUTEKIT_PRINCIPAL_HEADER
} from "./auth.js";
export type {
  GatewayPrincipal,
  WorkloadJwtPrincipalPolicy,
  WorkloadJwtVerifierOptions
} from "./auth.js";
export {
  errorEvent,
  finishChunk,
  noticeChunk,
  reasoningChunk,
  sseResponse
} from "./sse-wire.js";
export { ChatStreamAssembler } from "./sse/chat-assembler.js";
export { decodeBufferedSse, SseDecoder, SseParseError } from "./sse/parse.js";
