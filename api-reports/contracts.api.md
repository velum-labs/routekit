# @velum-labs/routekit-contracts

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `3d6e7f143f7c57dad31132dbd8e84ac1999d223e8e4f9119cfaee86926dcee73`

## Root declarations

```ts
export type { AccountActivityState, AccountReadinessReason, AccountReadinessState, CapabilityStatus, ModelArchitecture, ModelCallContract, ModelCallSideEffects, ModelCallStatus, ModelCapabilityMetadata, ModelChatMessage, ModelChatRole, ModelEndpoint, ModelSelectionSignals, ModelUsage, ProviderError, ProviderErrorKind, ProviderFailure, ProviderFailureCategory, RequestAttribution, RequestBillingMode, UpstreamAuthState } from "./model.js";
export type { AnthropicReasoningExtension, Citation, ContentPart, Conversation, ConversationMessage, ExtensionField, GoogleReasoningExtension, OpenAiUsageExtension, Reasoning, ResponsesReasoningExtension, ToolCall, ToolCallAssemblyExtension, ToolResult, Usage } from "./protocol-ir.js";
export type { CodexBillingScope, CodexCompatibility, CodexCompatibilityStatus, CodexModelCandidate, CodexStartupSelection } from "./codex.js";
export type { DecodeModelDiscoveryOptions, DecodeReasoningCapabilitiesOptions, DiscoveredProviderModel, ModelDiscoveryDiagnostic, ModelDiscoveryDiagnosticCode, ModelDiscoveryProtocolErrorCode, ProviderDiscoveryResponseShape } from "./provider-discovery.js";
export type { HarnessApprovalDecision, HarnessContentStream, HarnessEvent, HarnessEventRaw, HarnessEventType, HarnessItemType, HarnessRequestType, HarnessTokenUsage, HarnessTurnEndReason } from "./harness-event.js";
export type { JsonValue } from "./jcs.js";
export type { ModelEffortVariant, ModelEffortVariantCodec, ModelEffortVariantEntry, ModelEffortVariantErrorCode, ModelEffortVariantResolution, ModelReasoningCapabilities, ReasoningCapabilityProvenance, ReasoningCapabilityStatus, ReasoningEffortDescriptor, ReasoningEffortOption, ReasoningSelection, ReasoningSelectionErrorCode, ReasoningSelectionResolution } from "./reasoning.js";
export { CURSOR_MODEL_NAMESPACE, classifyProviderFailure, cursorModelName, isRetryableProviderFailure, ProviderFailureError, parseRetryAfterSeconds, stripCursorNamespace } from "./model.js";
export { EFFORT_QUALIFIED_MODEL_CODEC, effortQualifiedClientModel, enumerateModelEffortVariants, isCodexPickerEligibleModel, modelEffortVariantCollisions, parseReasoningSelection, reasoningEffortDescriptors, reasoningSelectionEquals, reasoningSelectionFromEffort, resolveModelEffortVariant, resolveReasoningEffort, resolveReasoningSelection } from "./reasoning.js";
export { artifactHash, hashCanonical, hashCanonicalSha256, requestHash, responseHash, SHA256_PREFIX, schemaBundleHash, sha256Hex, sha256PrefixedHex } from "./hash.js";
export { canonicalize } from "./jcs.js";
export { codexCompatibility, selectCodexStartupModel, withCodexCapabilityMetadata } from "./codex.js";
export { conversationFromOpenAiMessages, conversationText, extensionValue } from "./protocol-ir.js";
export { decodeModelDiscovery, decodeReasoningCapabilities, ModelDiscoveryProtocolError } from "./provider-discovery.js";
```
