# @velum-labs/routekit-contracts/harness

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `1af0e5890eeff13e6c2e652fae29bf246b46a0dd39826c91d03dd44e9c0e7c57`

## Root declarations

```ts
export type HarnessApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type HarnessContentStream = "assistant_text" | "reasoning_text" | "command_output" | "tool_output";
export type HarnessEvent<K extends string = string> = (BaseHarnessEvent<K> & {
export type HarnessEventRaw = {
export type HarnessEventType = HarnessEvent["type"];
export type HarnessItemType = "assistant_message" | "reasoning" | "command_execution" | "file_change" | "web_search" | "dynamic_tool_call";
export type HarnessRequestType = "exec_command_approval" | "file_change_approval" | "file_read_approval" | "tool_approval" | "tool_user_input";
export type HarnessTokenUsage = {
export type HarnessTurnEndReason = "completed" | "interrupted" | "timeout" | "aborted" | "error";
export {};
```
