import type { SimBehavior, SimError, SimToolCall } from "./behaviors.js";

export type SimSseEvent = {
  event?: string;
  data: unknown;
};

export function normalizeBehavior(
  input: SimBehavior
): Required<Pick<SimBehavior, "tool_calls" | "delay_s" | "chunk_delay_s" | "prompt_tokens">> &
  SimBehavior {
  return {
    ...input,
    tool_calls: input.tool_calls ?? [],
    delay_s: input.delay_s ?? 0,
    chunk_delay_s: input.chunk_delay_s ?? 0,
    prompt_tokens: input.prompt_tokens ?? 7
  };
}

export function behaviorKind(behavior: SimBehavior): "reply" | "tool_calls" | "error" {
  if (behavior.error !== undefined && behavior.error !== null) return "error";
  return (behavior.tool_calls?.length ?? 0) > 0 ? "tool_calls" : "reply";
}

export function completionTokens(behavior: SimBehavior): number {
  if (behavior.completion_tokens !== undefined && behavior.completion_tokens !== null) {
    return behavior.completion_tokens;
  }
  return Math.max(
    1,
    (behavior.reply ?? "").split(/\s+/).filter(Boolean).length +
      4 * (behavior.tool_calls?.length ?? 0)
  );
}

export function finishReason(behavior: SimBehavior): "stop" | "tool_calls" {
  return (behavior.tool_calls?.length ?? 0) > 0 ? "tool_calls" : "stop";
}

export function tokenize(text: string): string[] {
  const parts = text.split(" ");
  return parts.map((part, index) => `${part}${index < parts.length - 1 ? " " : ""}`);
}

export function argumentFragments(argumentsJson: string, parts = 2): string[] {
  if (argumentsJson.length <= 4) return [argumentsJson];
  const size = Math.max(1, Math.floor(argumentsJson.length / parts));
  const fragments: string[] = [];
  for (let offset = 0; offset < argumentsJson.length; offset += size) {
    fragments.push(argumentsJson.slice(offset, offset + size));
  }
  return fragments;
}

export function openAiError(error: SimError): unknown {
  return {
    error: {
      message: error.message ?? "simulated provider error",
      type: error.error_type ?? "api_error",
      param: null,
      code: error.code ?? "internal_error"
    }
  };
}

function openAiUsage(behavior: SimBehavior): Record<string, number> {
  const output = completionTokens(behavior);
  const input = behavior.prompt_tokens ?? 7;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

export function openAiChatBody(model: string, behavior: SimBehavior, id: string): unknown {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: behavior.reply ?? null
  };
  if ((behavior.tool_calls?.length ?? 0) > 0) {
    message.tool_calls = behavior.tool_calls!.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments ?? "{}" }
    }));
  }
  if (behavior.reasoning !== undefined && behavior.reasoning !== null) {
    message.reasoning_content = behavior.reasoning;
  }
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason(behavior) }],
    usage: openAiUsage(behavior)
  };
}

export function openAiChatEvents(
  model: string,
  behavior: SimBehavior,
  id: string,
  includeUsage: boolean
): SimSseEvent[] {
  const chunk = (delta: Record<string, unknown>, end: string | null = null): unknown => ({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: end }]
  });
  const events: SimSseEvent[] = [{ data: chunk({ role: "assistant", content: "" }) }];
  for (const token of tokenize(behavior.reasoning ?? "")) {
    if (token.length > 0) events.push({ data: chunk({ reasoning_content: token }) });
  }
  for (const token of tokenize(behavior.reply ?? "")) {
    if (token.length > 0) events.push({ data: chunk({ content: token }) });
  }
  const calls = behavior.tool_calls ?? [];
  if (calls.length > 0) {
    events.push({
      data: chunk({
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: "" }
        }))
      })
    });
    calls.forEach((call, index) => {
      for (const fragment of argumentFragments(call.arguments ?? "{}", 3)) {
        events.push({
          data: chunk({ tool_calls: [{ index, function: { arguments: fragment } }] })
        });
      }
    });
  }
  events.push({ data: chunk({}, finishReason(behavior)) });
  if (includeUsage) {
    events.push({
      data: {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        usage: openAiUsage(behavior)
      }
    });
  }
  return events;
}

export function anthropicError(error: SimError): unknown {
  return {
    type: "error",
    error: {
      type: error.error_type ?? "api_error",
      message: error.message ?? "simulated provider error"
    }
  };
}

function parsedArguments(call: SimToolCall): unknown {
  try {
    return JSON.parse(call.arguments ?? "{}");
  } catch {
    return {};
  }
}

function anthropicBlocks(behavior: SimBehavior): unknown[] {
  const blocks: unknown[] = [];
  if (behavior.reasoning !== undefined && behavior.reasoning !== null) {
    blocks.push({
      type: "thinking",
      thinking: behavior.reasoning,
      signature: behavior.reasoning_signature ?? ""
    });
  }
  if (behavior.redacted_thinking !== undefined && behavior.redacted_thinking !== null) {
    blocks.push({ type: "redacted_thinking", data: behavior.redacted_thinking });
  }
  if (behavior.reply !== undefined && behavior.reply !== null) {
    blocks.push({ type: "text", text: behavior.reply });
  }
  for (const call of behavior.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: parsedArguments(call)
    });
  }
  return blocks;
}

export function anthropicBody(model: string, behavior: SimBehavior, id: string): unknown {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: anthropicBlocks(behavior),
    stop_reason: (behavior.tool_calls?.length ?? 0) > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: behavior.prompt_tokens ?? 7,
      output_tokens: completionTokens(behavior)
    }
  };
}

export function anthropicEvents(model: string, behavior: SimBehavior, id: string): SimSseEvent[] {
  const events: SimSseEvent[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: behavior.prompt_tokens ?? 7, output_tokens: 0 }
        }
      }
    }
  ];
  let index = 0;
  if (behavior.reasoning !== undefined && behavior.reasoning !== null) {
    events.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" }
      }
    });
    for (const token of tokenize(behavior.reasoning)) {
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: token }
        }
      });
    }
    if (behavior.reasoning_signature !== null) {
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: behavior.reasoning_signature ?? "sim" }
        }
      });
    }
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    index += 1;
  }
  if (behavior.redacted_thinking !== undefined && behavior.redacted_thinking !== null) {
    events.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "redacted_thinking", data: behavior.redacted_thinking }
      }
    });
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    index += 1;
  }
  if (behavior.reply !== undefined && behavior.reply !== null) {
    events.push({
      event: "content_block_start",
      data: { type: "content_block_start", index, content_block: { type: "text", text: "" } }
    });
    for (const token of tokenize(behavior.reply)) {
      if (token.length === 0) continue;
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: token }
        }
      });
    }
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    index += 1;
  }
  for (const call of behavior.tool_calls ?? []) {
    events.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} }
      }
    });
    for (const fragment of argumentFragments(call.arguments ?? "{}")) {
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: fragment }
        }
      });
    }
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    index += 1;
  }
  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: {
        stop_reason: (behavior.tool_calls?.length ?? 0) > 0 ? "tool_use" : "end_turn",
        stop_sequence: null
      },
      usage: { output_tokens: completionTokens(behavior) }
    }
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return events;
}

export function responsesError(error: SimError): unknown {
  return openAiError(error);
}

function responsesUsage(behavior: SimBehavior): unknown {
  const input = behavior.prompt_tokens ?? 7;
  const output = completionTokens(behavior);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output
  };
}

function responseOutput(behavior: SimBehavior, id: string): unknown[] {
  const output: unknown[] = [];
  if (behavior.reasoning !== undefined && behavior.reasoning !== null) {
    output.push({
      id: `${id}_rs0`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: behavior.reasoning }]
    });
  }
  if (behavior.reply !== undefined && behavior.reply !== null) {
    output.push({
      id: `${id}_msg0`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: behavior.reply, annotations: [] }]
    });
  }
  (behavior.tool_calls ?? []).forEach((call, index) => {
    output.push({
      id: `${id}_fc${index}`,
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments ?? "{}",
      status: "completed"
    });
  });
  return output;
}

export function responsesBody(
  model: string,
  behavior: SimBehavior,
  id: string,
  status: "in_progress" | "completed" = "completed"
): unknown {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output: status === "completed" ? responseOutput(behavior, id) : [],
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    ...(status === "completed" ? { usage: responsesUsage(behavior) } : {})
  };
}

export function responsesEvents(model: string, behavior: SimBehavior, id: string): SimSseEvent[] {
  let sequence = 0;
  const event = (data: Record<string, unknown>): SimSseEvent => {
    sequence += 1;
    return { event: String(data.type), data: { ...data, sequence_number: sequence } };
  };
  const events: SimSseEvent[] = [
    event({ type: "response.created", response: responsesBody(model, behavior, id, "in_progress") })
  ];
  let outputIndex = 0;
  for (const token of tokenize(behavior.reasoning ?? "")) {
    if (token.length === 0) continue;
    events.push(
      event({
        type: "response.reasoning_summary_text.delta",
        delta: token,
        item_id: `${id}_rs0`,
        output_index: outputIndex,
        summary_index: 0
      })
    );
  }
  if (behavior.reasoning !== undefined && behavior.reasoning !== null) outputIndex += 1;
  for (const token of tokenize(behavior.reply ?? "")) {
    if (token.length === 0) continue;
    events.push(
      event({
        type: "response.output_text.delta",
        delta: token,
        item_id: `${id}_msg0`,
        content_index: 0,
        output_index: outputIndex,
        logprobs: []
      })
    );
  }
  if (behavior.reply !== undefined && behavior.reply !== null) outputIndex += 1;
  (behavior.tool_calls ?? []).forEach((call, index) => {
    const itemId = `${id}_fc${index}`;
    events.push(
      event({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          id: itemId,
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: "",
          status: "in_progress"
        }
      })
    );
    for (const fragment of argumentFragments(call.arguments ?? "{}")) {
      events.push(
        event({
          type: "response.function_call_arguments.delta",
          delta: fragment,
          item_id: itemId,
          output_index: outputIndex
        })
      );
    }
    outputIndex += 1;
  });
  events.push(event({ type: "response.completed", response: responsesBody(model, behavior, id) }));
  return events;
}

const GOOGLE_STATUS: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  503: "UNAVAILABLE",
  529: "UNAVAILABLE"
};

export function googleError(error: SimError): unknown {
  const status = error.status ?? 500;
  return {
    error: {
      code: status,
      message: error.message ?? "simulated provider error",
      status: GOOGLE_STATUS[status] ?? "UNKNOWN"
    }
  };
}

function googleFunctionCall(call: SimToolCall): unknown {
  return { functionCall: { id: call.id, name: call.name, args: parsedArguments(call) } };
}

function googleUsage(behavior: SimBehavior): unknown {
  const input = behavior.prompt_tokens ?? 7;
  const output = completionTokens(behavior);
  return {
    promptTokenCount: input,
    candidatesTokenCount: output,
    totalTokenCount: input + output
  };
}

function googleParts(behavior: SimBehavior): unknown[] {
  return [
    ...(behavior.reasoning !== undefined && behavior.reasoning !== null
      ? [{ text: behavior.reasoning, thought: true }]
      : []),
    ...(behavior.reply !== undefined && behavior.reply !== null ? [{ text: behavior.reply }] : []),
    ...(behavior.tool_calls ?? []).map(googleFunctionCall)
  ];
}

export function googleBody(behavior: SimBehavior): unknown {
  return {
    candidates: [
      {
        content: { role: "model", parts: googleParts(behavior) },
        finishReason: "STOP",
        index: 0
      }
    ],
    usageMetadata: googleUsage(behavior),
    modelVersion: "simulated"
  };
}

export function googleEvents(behavior: SimBehavior): SimSseEvent[] {
  const events: SimSseEvent[] = [];
  for (const token of tokenize(behavior.reasoning ?? "")) {
    if (token.length > 0) {
      events.push({
        data: {
          candidates: [
            { content: { role: "model", parts: [{ text: token, thought: true }] }, index: 0 }
          ]
        }
      });
    }
  }
  for (const token of tokenize(behavior.reply ?? "")) {
    if (token.length > 0) {
      events.push({
        data: { candidates: [{ content: { role: "model", parts: [{ text: token }] }, index: 0 }] }
      });
    }
  }
  events.push({
    data: {
      candidates: [
        {
          content: { role: "model", parts: (behavior.tool_calls ?? []).map(googleFunctionCall) },
          finishReason: "STOP",
          index: 0
        }
      ],
      usageMetadata: googleUsage(behavior)
    }
  });
  return events;
}

export function sseBytes(events: readonly SimSseEvent[], done = false): Uint8Array {
  const text = events
    .map(
      (entry) =>
        `${entry.event !== undefined ? `event: ${entry.event}\n` : ""}data: ${JSON.stringify(entry.data)}\n\n`
    )
    .join("");
  return new TextEncoder().encode(`${text}${done ? "data: [DONE]\n\n" : ""}`);
}
