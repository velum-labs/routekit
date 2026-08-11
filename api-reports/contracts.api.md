# @velum-labs/routekit-contracts

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `f59c4bce32c4e445399c2ad51f1cd01398264cfd9c37ec69216293928bd2dfc4`

## Root declarations

```ts
export type { AccountActivityState, AccountReadinessReason, AccountReadinessState, CapabilityStatus, ModelArchitecture, ModelCapabilityMetadata, ModelSelectionSignals, ModelCallContract, ModelCallSideEffects, ModelCallStatus, ModelChatMessage, ModelChatRole, ModelEndpoint, ModelUsage, ProviderError, ProviderErrorKind, ProviderFailure, ProviderFailureCategory, RequestAttribution, RequestBillingMode, UpstreamAuthState } from "./model.js";
export type { CodexBillingScope, CodexCompatibility, CodexCompatibilityStatus, CodexModelCandidate, CodexStartupSelection } from "./codex.js";
export type { HarnessApprovalDecision, HarnessContentStream, HarnessEvent, HarnessEventRaw, HarnessEventType, HarnessItemType, HarnessRequestType, HarnessTokenUsage, HarnessTurnEndReason } from "./harness-event.js";
export type { JsonValue } from "./jcs.js";
export type { ModelEffortVariant, ModelEffortVariantCodec, ModelEffortVariantEntry, ModelEffortVariantErrorCode, ModelEffortVariantResolution, ModelReasoningCapabilities, ReasoningCapabilityProvenance, ReasoningCapabilityStatus, ReasoningEffortDescriptor, ReasoningEffortOption, ReasoningSelection, ReasoningSelectionErrorCode, ReasoningSelectionResolution } from "./reasoning.js";
export { CURSOR_MODEL_NAMESPACE, classifyProviderFailure, cursorModelName, isRetryableProviderFailure, ProviderFailureError, parseRetryAfterSeconds, stripCursorNamespace } from "./model.js";
export { EFFORT_QUALIFIED_MODEL_CODEC, effortQualifiedClientModel, enumerateModelEffortVariants, isCodexPickerEligibleModel, modelEffortVariantCollisions, parseReasoningSelection, reasoningEffortDescriptors, reasoningSelectionEquals, reasoningSelectionFromEffort, resolveModelEffortVariant, resolveReasoningEffort, resolveReasoningSelection } from "./reasoning.js";
export { artifactHash, hashCanonical, hashCanonicalSha256, requestHash, responseHash, SHA256_PREFIX, schemaBundleHash, sha256Hex, sha256PrefixedHex } from "./hash.js";
export { canonicalize } from "./jcs.js";
export { codexCompatibility, selectCodexStartupModel, withCodexCapabilityMetadata } from "./codex.js";
```
