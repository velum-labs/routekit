import { Option, Schema } from "effect";

import type { ClaudeInbound } from "../native/schema.ts";
import type { AgentAdapterEvent } from "../../../../../contracts/internal/src/runtime/agent-adapter-event.ts";

import {
  ClaudeModelUsageRecord,
  ClaudeResultUsage,
  ClaudeTotalCost,
  ToolResultBlock,
  ToolUseBlock,
} from "../native/schema.ts";
import { StreamDelta } from "../native/stream-delta.ts";

// The assistant/user content unions each carry a permissive `{ type: string }`
// fallback, so a block whose payload failed to decode still surfaces with its
// original `type`. Structural guards reject that fallback, so a malformed
// tool block projects to nothing instead of an update with undefined fields —
// a discriminant-only compare would wrongly admit it.
const isToolUse = Schema.is(ToolUseBlock);
const isToolResult = Schema.is(ToolResultBlock);
const decodeResultUsage = Schema.decodeUnknownOption(ClaudeResultUsage);
const decodeModelUsage = Schema.decodeUnknownOption(ClaudeModelUsageRecord);
const decodeTotalCost = Schema.decodeUnknownOption(ClaudeTotalCost);

const tokenValue = (...values: readonly (number | undefined)[]): number =>
  values.find((value) => value !== undefined) ?? 0;

const received = (
  update: Extract<
    AgentAdapterEvent,
    { readonly event: "acp.session_update" }
  >["update"]
): AgentAdapterEvent => ({
  event: "acp.session_update",
  update,
});

// The delta already decoded into a tagged variant at the boundary, so this only
// maps the two projected kinds to their chunk; every other kind is no update.
const streamDeltaUpdate = (
  delta: StreamDelta
): AgentAdapterEvent | undefined => {
  if (StreamDelta.guards.TextDelta(delta)) {
    return received({
      content: {
        text: delta.text,
        type: "text",
      },
      sessionUpdate: "agent_message_chunk",
    });
  }
  if (StreamDelta.guards.ThinkingDelta(delta)) {
    return received({
      content: {
        text: delta.text,
        type: "text",
      },
      sessionUpdate: "agent_thought_chunk",
    });
  }
  return undefined;
};

const projectUsageUpdate = (
  event: Extract<ClaudeInbound, { readonly type: "result" }>
): AgentAdapterEvent | undefined => {
  const usage = Option.getOrUndefined(decodeResultUsage(event.usage));
  if (usage === undefined) {
    return undefined;
  }
  const modelUsage = Option.getOrUndefined(decodeModelUsage(event.modelUsage));
  const modelEntries =
    modelUsage === undefined ? [] : Object.entries(modelUsage);
  const modelEntry = modelEntries.length === 1 ? modelEntries[0] : undefined;
  const model = modelEntry?.[0];
  const contextWindowValues = [
    ...new Set(
      modelEntries
        .map(([, value]) => value.contextWindow)
        .filter((value): value is number => value !== undefined && value > 0)
    ),
  ];
  const contextWindow =
    contextWindowValues.length === 1 ? contextWindowValues[0] : undefined;
  const costUsd = Option.getOrUndefined(decodeTotalCost(event.total_cost_usd));
  const cumulative = modelEntry?.[1];
  const contextTokens =
    tokenValue(usage.cache_creation_input_tokens) +
    tokenValue(usage.cache_read_input_tokens) +
    tokenValue(usage.input_tokens) +
    tokenValue(usage.output_tokens);
  const runtimeUsage = {
    // Top-level usage is the final API call and therefore the occupancy signal.
    // Cumulative modelUsage keeps token totals consistent with whole-turn cost.
    cacheCreationTokens: tokenValue(
      cumulative?.cacheCreationInputTokens,
      usage.cache_creation_input_tokens
    ),
    cacheReadTokens: tokenValue(
      cumulative?.cacheReadInputTokens,
      usage.cache_read_input_tokens
    ),
    contextTokens,
    ...(model === undefined ? {} : { model }),
    ...(costUsd === undefined ? {} : { costUsd }),
    inputTokens: tokenValue(cumulative?.inputTokens, usage.input_tokens),
    outputTokens: tokenValue(cumulative?.outputTokens, usage.output_tokens),
  };
  return received({
    _meta: { "routekit-eval.runtimeUsage": runtimeUsage },
    ...(costUsd === undefined
      ? {}
      : {
          cost: {
            amount: costUsd,
            currency: "USD",
          },
        }),
    sessionUpdate: "usage_update",
    size: contextWindow ?? 0,
    used: contextTokens,
  });
};

/**
 * Projects a decoded Claude native event to ACP `session/update` events. Yields
 * nothing for events this arm does not own — observations (handled by
 * `projectClaudeObservation`), `control_request` (handled by the elicitation
 * path), and recognized events that carry no ACP update — so the projector can
 * concatenate arms without a sentinel return.
 *
 * @yields {AgentAdapterEvent} each ACP `session/update` event from `event`.
 */
const projectClaudeSessionUpdate = function* (
  event: ClaudeInbound
): Generator<AgentAdapterEvent> {
  if (event.type === "stream_event") {
    const update =
      event.event.delta === undefined
        ? undefined
        : streamDeltaUpdate(event.event.delta);
    if (update !== undefined) {
      yield update;
    }
    return;
  }
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (!isToolUse(block)) {
        continue;
      }
      yield received({
        rawInput: block.input,
        sessionUpdate: "tool_call",
        status: "pending",
        title: block.name,
        toolCallId: block.id,
      });
      yield received({
        sessionUpdate: "tool_call_update",
        status: "in_progress",
        toolCallId: block.id,
      });
    }
    return;
  }
  if (event.type === "user") {
    for (const block of event.message.content) {
      if (!isToolResult(block)) {
        continue;
      }
      yield received({
        sessionUpdate: "tool_call_update",
        status: block.is_error === true ? "failed" : "completed",
        toolCallId: block.tool_use_id,
      });
    }
    return;
  }
  if (event.type === "result") {
    const update = projectUsageUpdate(event);
    if (update !== undefined) {
      yield update;
    }
  }
};

export { projectClaudeSessionUpdate };
