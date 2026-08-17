/**
 * GPT-5.6 Chat Completions rejects forced tool calls when reasoning is active.
 * Keep authoring requests explicit instead of relying on a provider default.
 */
export const TESTDRIVE_TOOL_CALL_REASONING_EFFORT = "none" as const;
