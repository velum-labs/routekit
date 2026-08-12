# @velum-labs/routekit-contracts/protocol-ir

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `e0a4f3b2bc1ff33663fc4a8f91b7b0b41ce17573c0b8de15ed6158d5adba5054`

## Root declarations

```ts
export declare function conversationFromOpenAiMessages(messages: readonly Readonly<{
export declare function conversationText(message: ConversationMessage): string;
export declare function extensionValue<Namespace extends string, Value>(extensions: readonly ExtensionField[] | undefined, namespace: Namespace): Value | undefined;
export type AnthropicReasoningExtension = ExtensionField<"anthropic.reasoning", Readonly<{
export type Citation = Readonly<{
export type ContentPart = Readonly<{
export type Conversation = Readonly<{
export type ConversationMessage = Readonly<{
export type ExtensionField<Namespace extends string = string, Value = unknown> = Readonly<{
export type GoogleReasoningExtension = ExtensionField<"google.reasoning", Readonly<{
export type OpenAiUsageExtension = ExtensionField<"openai.chat.usage-details", Readonly<{
export type Reasoning = Readonly<{
export type ResponsesReasoningExtension = ExtensionField<"openai.responses.reasoning", Readonly<{
export type ToolCall = Readonly<{
export type ToolCallAssemblyExtension = ExtensionField<"routekit.tool-call-assembly", Readonly<{
export type ToolResult = Readonly<{
export type Usage = Readonly<{
```
