import { Option, Schema } from "effect";

import type { AgentAdapterEvent } from "../../../../../contracts/internal/src/runtime/agent-adapter-event.ts";

import { AssistantMessageDelta } from "../native/assistant-message.ts";
import { PiKnownSessionEvent, UsageBearingPiMessage } from "../native/schema.ts";
import { PiUsage } from "../native/usage.ts";

const DEFAULT_TOKENS = 0;

const contextTokens = (usage: typeof PiUsage.Type): number =>
  usage.totalTokens ??
  (usage.input ?? DEFAULT_TOKENS) +
    (usage.cacheRead ?? DEFAULT_TOKENS) +
    (usage.cacheWrite ?? DEFAULT_TOKENS) +
    (usage.output ?? DEFAULT_TOKENS);

const received = (
  update: Extract<
    AgentAdapterEvent,
    { readonly event: "acp.session_update" }
  >["update"]
): AgentAdapterEvent => ({
  event: "acp.session_update",
  update,
});

const projectUsageUpdate = (
  event: Extract<
    PiKnownSessionEvent,
    { readonly type: "message_end" | "turn_end" }
  >,
  cumulativeCost = 0
): AgentAdapterEvent | undefined => {
  const message = Option.getOrUndefined(
    Schema.decodeUnknownOption(UsageBearingPiMessage)(event.message)
  );
  // Only assistant messages carry billable round usage; user and tool-result
  // records must not contribute to cumulative cost.
  if (message?.role !== "assistant" || message.usage === undefined) {
    return undefined;
  }
  const usage = Option.getOrUndefined(
    Schema.decodeUnknownOption(PiUsage)(message.usage)
  );
  if (usage === undefined) {
    return undefined;
  }
  const runtimeUsage = {
    cacheCreationTokens: usage.cacheWrite ?? DEFAULT_TOKENS,
    cacheReadTokens: usage.cacheRead ?? DEFAULT_TOKENS,
    // Pi's OpenAI-compatible parser defines totalTokens as uncached input plus cache reads, cache writes, and output.
    contextTokens: contextTokens(usage),
    ...(usage.cost?.total === undefined ? {} : { costUsd: usage.cost.total }),
    ...(message.responseId === undefined
      ? {}
      : { generationId: message.responseId }),
    inputTokens: usage.input ?? DEFAULT_TOKENS,
    ...((message.responseModel ?? message.model) === undefined
      ? {}
      : { model: message.responseModel ?? message.model }),
    outputTokens: usage.output ?? DEFAULT_TOKENS,
  };
  const messageCost = usage.cost?.total;
  const nextCumulativeCost =
    messageCost !== undefined && messageCost > 0
      ? cumulativeCost + messageCost
      : cumulativeCost;
  return received({
    _meta: { "ori.runtimeUsage": runtimeUsage },
    ...(nextCumulativeCost > 0
      ? {
          cost: {
            amount: nextCumulativeCost,
            currency: "USD",
          },
        }
      : {}),
    sessionUpdate: "usage_update",
    // ACP requires size, but Pi does not report its context-window limit.
    // The selected-adapter projection replaces this sentinel with the real
    // invocation window when one is available.
    size: 0,
    used: runtimeUsage.contextTokens,
  });
};

const projectUsageUpdates = function* (
  event: PiKnownSessionEvent,
  cumulativeCost: number,
  includeUsage: boolean
): Generator<AgentAdapterEvent> {
  const { guards } = PiKnownSessionEvent;
  if (includeUsage && (guards.message_end(event) || guards.turn_end(event))) {
    const usageUpdate = projectUsageUpdate(event, cumulativeCost);
    if (usageUpdate !== undefined) {
      yield usageUpdate;
    }
  }
};

/**
 * Projects a decoded Pi session event to ACP `session/update` events. Yields
 * nothing for events this arm does not own — observations (handled by
 * `projectPiObservation`) and recognized events that carry no ACP update — so
 * the projector can concatenate arms without a sentinel return.
 *
 * @yields {AgentAdapterEvent} each ACP `session/update` event from `event`.
 */
const projectPiSessionUpdate = function* (
  event: PiKnownSessionEvent,
  cumulativeCost = 0,
  includeUsage = true
): Generator<AgentAdapterEvent> {
  const { guards } = PiKnownSessionEvent;
  if (guards.message_update(event)) {
    const delta = event.assistantMessageEvent;
    if (AssistantMessageDelta.guards.TextDelta(delta)) {
      yield received({
        content: {
          text: delta.text,
          type: "text",
        },
        sessionUpdate: "agent_message_chunk",
      });
    } else if (AssistantMessageDelta.guards.ThinkingDelta(delta)) {
      yield received({
        content: {
          text: delta.text,
          type: "text",
        },
        sessionUpdate: "agent_thought_chunk",
      });
    }
    return;
  }
  if (guards.tool_execution_start(event)) {
    yield received({
      rawInput: event.args,
      sessionUpdate: "tool_call",
      status: "pending",
      title: event.toolName,
      toolCallId: event.toolCallId,
    });
    yield received({
      sessionUpdate: "tool_call_update",
      status: "in_progress",
      toolCallId: event.toolCallId,
    });
    return;
  }
  if (guards.tool_execution_end(event)) {
    yield received({
      content: event.result.content.map((content) => ({
        content,
        type: "content" as const,
      })),
      rawOutput: event.result,
      sessionUpdate: "tool_call_update",
      status: event.isError ? "failed" : "completed",
      toolCallId: event.toolCallId,
    });
    return;
  }
  if (guards.session_info_changed(event)) {
    yield received({
      sessionUpdate: "session_info_update",
      title: event.name ?? null,
    });
    return;
  }
  yield* projectUsageUpdates(event, cumulativeCost, includeUsage);
};

export { projectPiSessionUpdate };
