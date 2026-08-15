import type { AgentAdapterEvent } from "../../../../../contracts/internal/src/runtime/agent-adapter-event.ts";

import { CodexKnownSessionEvent } from "../native/schema.ts";

const received = (
  update: Extract<
    AgentAdapterEvent,
    { readonly event: "acp.session_update" }
  >["update"]
): AgentAdapterEvent => ({
  event: "acp.session_update",
  update,
});

// Codex reports these item types through `item/started`/`item/completed`;
// every other item type (e.g. a plain agent-message item, already covered by
// the delta events) has no ACP tool-call representation.
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "commandExecution",
  "mcpToolCall",
  "dynamicToolCall",
  "fileChange",
]);

/**
 * Projects a decoded Codex session event to ACP `session/update` events.
 * Yields nothing for events this arm does not own (retry/compaction,
 * handled by `projectCodexObservation`) so the projector can concatenate
 * arms without a sentinel return.
 *
 * @yields {AgentAdapterEvent} each ACP `session/update` event from `event`.
 */
const projectCodexSessionUpdate = function* (
  event: CodexKnownSessionEvent
): Generator<AgentAdapterEvent> {
  const { guards } = CodexKnownSessionEvent;
  if (guards["item/agentMessage/delta"](event)) {
    yield received({
      content: {
        text: event.params.delta,
        type: "text",
      },
      sessionUpdate: "agent_message_chunk",
    });
    return;
  }
  if (
    guards["item/reasoning/textDelta"](event) ||
    guards["item/reasoning/summaryTextDelta"](event)
  ) {
    yield received({
      content: {
        text: event.params.delta,
        type: "text",
      },
      sessionUpdate: "agent_thought_chunk",
    });
    return;
  }
  if (guards["item/started"](event)) {
    const { item } = event.params;
    if (!TOOL_ITEM_TYPES.has(item.type)) {
      return;
    }
    yield received({
      sessionUpdate: "tool_call",
      status: "pending",
      title: item.command ?? item.type,
      toolCallId: item.id,
    });
    yield received({
      sessionUpdate: "tool_call_update",
      status: "in_progress",
      toolCallId: item.id,
    });
    return;
  }
  if (guards["item/completed"](event)) {
    const { item } = event.params;
    if (!TOOL_ITEM_TYPES.has(item.type)) {
      return;
    }
    yield received({
      sessionUpdate: "tool_call_update",
      status: item.status === "failed" ? "failed" : "completed",
      toolCallId: item.id,
    });
    return;
  }
  if (guards["thread/tokenUsage/updated"](event)) {
    const { tokenUsage } = event.params;
    const used = tokenUsage.total.totalTokens;
    yield received({
      sessionUpdate: "usage_update",
      size: tokenUsage.modelContextWindow ?? used,
      used,
    });
  }
};

export { projectCodexSessionUpdate };
