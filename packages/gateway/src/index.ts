/** Product-neutral RouteKit gateway and router. */
export { startGateway } from "./server.js";
export type {
  Gateway,
  GatewayOptions,
  ProviderRelay,
  ProviderRelayDialect
} from "./server.js";
export { startSwitchingGatewayProxy } from "./switching-proxy.js";
export type { SwitchingGatewayProxy } from "./switching-proxy.js";

export { joinPath, ModelRoutedBackend, OpenAiBackend } from "./backend.js";
export type {
  Backend,
  BackendModelRoute,
  BackendRequestOptions,
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
  CatalogBackend,
  DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS,
  DEFAULT_LEADERBOARD_LIVE_LIMIT,
  DEFAULT_LEADERBOARD_LIVE_TTL_HOURS,
  isSubscriptionProvider,
  leaderboardConfigSchema,
  NoModelAvailableError,
  modelPolicyAllowsModel,
  modelPolicyRuleMatches,
  normalizeRouterConfigAliases,
  parseRouterConfig,
  resolveLeaderboardConfig,
  routerConfigSchema,
  splitNamespacedModel,
  UnknownModelError
} from "./router.js";
export type {
  CatalogBackendOptions,
  CatalogModelInfo,
  LeaderboardConfig,
  ModelPolicy,
  ProviderPolicy,
  RouterConfig
} from "./router.js";
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
  claudeEffortQualifiedModel,
  claudeModelAlias,
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
  customToolNames,
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
export { MAX_WEB_SEARCHES_PER_TURN, resolveWebSearchExecutor } from "./adapters/web-search.js";
export type {
  WebSearchDialect,
  WebSearchExecutor,
  WebSearchOutcome
} from "./adapters/web-search.js";
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
  parseProviderCost,
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
  parsePrincipalHeader,
  presentedCredential,
  resolvePrincipal,
  ROUTEKIT_PRINCIPAL_HEADER
} from "./auth.js";
export type { GatewayPrincipal } from "./auth.js";
export {
  errorEvent,
  finishChunk,
  noticeChunk,
  reasoningChunk,
  sseResponse
} from "./sse-wire.js";
export { ChatStreamAssembler } from "./sse/chat-assembler.js";
export type { AssembledToolCall } from "./sse/chat-assembler.js";
export { decodeBufferedSse, SseDecoder, SseParseError } from "./sse/parse.js";
