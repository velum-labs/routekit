# @velum-labs/routekit-contracts/reasoning

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `b334ff7a72a1e89797e6ad46d8aa13801ad4e549fedc9f45bf5ef28442c20d05`

## Root declarations

```ts
export declare const EFFORT_QUALIFIED_MODEL_CODEC: ModelEffortVariantCodec;
export declare function effortQualifiedClientModel(baseClientModel: string, selection: ReasoningSelection | undefined, codec?: ModelEffortVariantCodec): string;
export declare function enumerateModelEffortVariants(entry: ModelEffortVariantEntry, codec?: ModelEffortVariantCodec): ModelEffortVariant[];
export declare function isCodexPickerEligibleModel(input: {
export declare function modelEffortVariantCollisions(entries: readonly ModelEffortVariantEntry[], codec?: ModelEffortVariantCodec): string[];
export declare function parseReasoningSelection(value: unknown): ReasoningSelectionResolution;
export declare function reasoningEffortDescriptors(capabilities: ModelReasoningCapabilities | undefined): ReasoningEffortDescriptor[];
export declare function reasoningSelectionEquals(left: ReasoningSelection, right: ReasoningSelection): boolean;
export declare function reasoningSelectionFromEffort(capabilities: ModelReasoningCapabilities | undefined, requested: string): ReasoningSelectionResolution;
export declare function resolveModelEffortVariant(requested: string, entries: readonly ModelEffortVariantEntry[], codec?: ModelEffortVariantCodec): ModelEffortVariantResolution;
export declare function resolveReasoningEffort(capabilities: ModelReasoningCapabilities, requested: string): string | undefined;
export declare function resolveReasoningSelection(capabilities: ModelReasoningCapabilities | undefined, selection: ReasoningSelection): ReasoningSelectionResolution;
export type ModelEffortVariant = {
export type ModelEffortVariantCodec = {
export type ModelEffortVariantEntry = {
export type ModelEffortVariantErrorCode = "unknown_model" | "unsupported_effort" | "collision";
export type ModelEffortVariantResolution = {
export type ModelReasoningCapabilities = {
export type ReasoningCapabilityProvenance = "provider" | "config" | "builtin" | "unknown";
export type ReasoningCapabilityStatus = "supported" | "unsupported" | "unknown";
export type ReasoningEffortDescriptor = {
export type ReasoningEffortOption = {
export type ReasoningSelection = {
export type ReasoningSelectionErrorCode = "unknown_capability" | "unsupported" | "unsupported_effort" | "unsupported_adaptive" | "unsupported_budget" | "budget_out_of_range" | "invalid_selection";
export type ReasoningSelectionResolution = {
```
