/**
 * Anthropic Messages streaming codec. Translates OpenAI Chat Completions SSE
 * into Anthropic Messages SSE. JSON translation lives in `anthropic-codec.ts`.
 */

import type { Reasoning } from "@velum-labs/routekit-contracts/protocol-ir";
import { randomId } from "@velum-labs/routekit-runtime";
import { StreamPump } from "@velum-labs/routekit-runtime/sse";
import type { OpenAiChatSseEvent } from "../providers/protocol.js";
import { decodeOpenAiChatSseEvent } from "../providers/protocol.js";
import { SseParseError } from "../sse/parse.js";
import { mapStopReason } from "./anthropic-codec.js";
import { anthropicReasoningDetailsOf, anthropicReasoningExtension } from "./openai-chat-wire.js";
import type { ServerToolMarker } from "./server-tool-loop.js";
import { serverToolMarkerOf } from "./server-tool-loop.js";
import { unwrapUpstreamError } from "./upstream-error.js";

const ENCODER = new TextEncoder();

type OpenAiChunk = OpenAiChatSseEvent;

function sse(type: string, data: unknown): Uint8Array {
  return ENCODER.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

type StreamState = {
  started: boolean;
  textOpen: boolean;
  textIndex: number;
  thinkingOpen: boolean;
  thinkingIndex: number;
  thinkingSourceIndex: number | undefined;
  pendingNarration: string[];
  outputStarted: boolean;
  nextIndex: number;
  finished: boolean;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
};

export function openAiSseToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  // OpenAI tool-call fragments map onto Anthropic `tool_use` content blocks.
  // Fragments are keyed by `index` when present, else by `id`; an id/index-less
  // fragment (Anthropic/Responses translations omit `index`) appends to the last
  // open call. Keying everything to index 0 used to merge parallel index-less
  // calls into one block — the same bug the shared assembler now avoids.
  const toolBlockByIndex = new Map<number, number>();
  const toolBlockById = new Map<string, number>();
  const toolBlocks: number[] = [];
  let lastToolBlock: number | undefined;
  const messageId = `msg_${randomId()}`;
  const state: StreamState = {
    started: false,
    textOpen: false,
    textIndex: -1,
    thinkingOpen: false,
    thinkingIndex: -1,
    thinkingSourceIndex: undefined,
    pendingNarration: [],
    outputStarted: false,
    nextIndex: 0,
    finished: false,
    inputTokens: undefined,
    outputTokens: undefined
  };

  type Controller = ReadableStreamDefaultController<Uint8Array>;

  const ensureStarted = (controller: Controller): void => {
    if (state.started) return;
    state.started = true;
    controller.enqueue(
      sse("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          ...(state.inputTokens !== undefined ? { usage: { input_tokens: state.inputTokens } } : {})
        }
      })
    );
  };

  // Generic reasoning has no provider-verifiable signature. Native Anthropic
  // metadata below carries its real block lifecycle and signature separately.
  const ensureThinking = (controller: Controller): void => {
    ensureStarted(controller);
    if (state.thinkingOpen || state.outputStarted) return;
    state.thinkingOpen = true;
    state.thinkingSourceIndex = undefined;
    state.thinkingIndex = state.nextIndex++;
    controller.enqueue(
      sse("content_block_start", {
        type: "content_block_start",
        index: state.thinkingIndex,
        content_block: { type: "thinking", thinking: "" }
      })
    );
  };

  const closeThinking = (controller: Controller, sourceIndex?: number): void => {
    if (!state.thinkingOpen) return;
    if (
      sourceIndex !== undefined &&
      state.thinkingSourceIndex !== undefined &&
      sourceIndex !== state.thinkingSourceIndex
    ) {
      return;
    }
    state.thinkingOpen = false;
    controller.enqueue(
      sse("content_block_stop", { type: "content_block_stop", index: state.thinkingIndex })
    );
    state.thinkingSourceIndex = undefined;
  };

  const emitNarration = (controller: Controller, text: string): void => {
    ensureThinking(controller);
    if (!state.thinkingOpen || state.thinkingSourceIndex !== undefined) return;
    controller.enqueue(
      sse("content_block_delta", {
        type: "content_block_delta",
        index: state.thinkingIndex,
        delta: {
          type: "thinking_delta",
          thinking: text.replace(/\*\*/g, "")
        }
      })
    );
  };

  const flushPendingNarration = (controller: Controller): void => {
    if (state.pendingNarration.length === 0) return;
    const pending = state.pendingNarration.join("");
    state.pendingNarration = [];
    emitNarration(controller, pending);
  };

  const ensureText = (controller: Controller): void => {
    ensureStarted(controller);
    closeThinking(controller);
    flushPendingNarration(controller);
    closeThinking(controller);
    state.outputStarted = true;
    if (state.textOpen) return;
    state.textOpen = true;
    state.textIndex = state.nextIndex++;
    controller.enqueue(
      sse("content_block_start", {
        type: "content_block_start",
        index: state.textIndex,
        content_block: { type: "text", text: "" }
      })
    );
  };

  const closeOpenBlocks = (controller: Controller): void => {
    closeThinking(controller);
    flushPendingNarration(controller);
    closeThinking(controller);
    if (state.textOpen) {
      controller.enqueue(
        sse("content_block_stop", { type: "content_block_stop", index: state.textIndex })
      );
    }
    for (const index of toolBlocks) {
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
    }
  };

  const finalize = (
    controller: Controller,
    stopReason: string,
    stopSequence: string | null = null
  ): void => {
    if (state.finished) return;
    state.finished = true;
    closeOpenBlocks(controller);
    controller.enqueue(
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: stopSequence },
        ...(state.inputTokens !== undefined || state.outputTokens !== undefined
          ? {
              usage: {
                ...(state.inputTokens !== undefined ? { input_tokens: state.inputTokens } : {}),
                ...(state.outputTokens !== undefined ? { output_tokens: state.outputTokens } : {})
              }
            }
          : {})
      })
    );
    controller.enqueue(sse("message_stop", { type: "message_stop" }));
  };

  /**
   * The upstream ended (reader closed or a `[DONE]` arrived) before any
   * `finish_reason`. Truncation is an error, not a clean stop (WS5.2): emit an
   * Anthropic `error` event rather than fabricating `stop_reason:"end_turn"`, so
   * the caller sees a failed turn instead of silently accepting a partial answer.
   */
  const finalizeTruncated = (controller: Controller, detail: string): void => {
    if (state.finished) return;
    state.finished = true;
    closeOpenBlocks(controller);
    controller.enqueue(
      sse("error", {
        type: "error",
        error: { type: "incomplete_stream", message: detail }
      })
    );
  };

  const finalizeUpstreamError = (controller: Controller, error: unknown): void => {
    if (state.finished) return;
    state.finished = true;
    closeOpenBlocks(controller);
    controller.enqueue(
      sse("error", {
        type: "error",
        error: unwrapUpstreamError(JSON.stringify({ error }))
      })
    );
  };

  // The server-tool loop injects marker chunks around each gateway-executed
  // web search; render them as native `server_tool_use` /
  // `web_search_tool_result` blocks (each opened and closed immediately —
  // their content is complete when the marker arrives).
  const handleServerToolMarker = (controller: Controller, marker: ServerToolMarker): void => {
    ensureStarted(controller);
    closeThinking(controller);
    flushPendingNarration(controller);
    closeThinking(controller);
    state.outputStarted = true;
    if (marker.phase === "start") {
      const index = state.nextIndex++;
      controller.enqueue(
        sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "server_tool_use",
            id: marker.item_id,
            name: "web_search",
            input: {}
          }
        })
      );
      controller.enqueue(
        sse("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: marker.query }) }
        })
      );
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
      return;
    }
    const index = state.nextIndex++;
    const content: unknown =
      marker.status === "failed"
        ? { type: "web_search_tool_result_error", error_code: "unavailable" }
        : (marker.result_blocks ?? []);
    controller.enqueue(
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "web_search_tool_result", tool_use_id: marker.item_id, content }
      })
    );
    controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
    // A completed server-side tool step is an internal model boundary, not the
    // final answer. The continuation model may legitimately begin with another
    // signed thinking/redacted block.
    state.outputStarted = false;
  };

  const handleReasoningDetails = (
    controller: Controller,
    details: readonly Reasoning[]
  ): boolean => {
    let carriedText = false;
    for (const detail of details) {
      const metadata = anthropicReasoningExtension(detail);
      if (metadata === undefined) continue;
      if (metadata.redacted === true) {
        if (state.outputStarted) continue;
        ensureStarted(controller);
        closeThinking(controller);
        const index = state.nextIndex++;
        controller.enqueue(
          sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "redacted_thinking", data: detail.encryptedContent ?? "" }
          })
        );
        controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
        continue;
      }
      if (metadata.phase === "start") {
        if (state.outputStarted) continue;
        ensureStarted(controller);
        closeThinking(controller);
        state.thinkingOpen = true;
        state.thinkingSourceIndex = metadata.index;
        state.thinkingIndex = state.nextIndex++;
        controller.enqueue(
          sse("content_block_start", {
            type: "content_block_start",
            index: state.thinkingIndex,
            content_block: {
              type: "thinking",
              thinking: "",
              signature: metadata.signature ?? ""
            }
          })
        );
        continue;
      }
      if (
        state.thinkingSourceIndex !== metadata.index ||
        !state.thinkingOpen ||
        state.outputStarted
      ) {
        continue;
      }
      if (metadata.phase === "delta" && typeof detail.text === "string") {
        carriedText = true;
        controller.enqueue(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: state.thinkingIndex,
            delta: { type: "thinking_delta", thinking: detail.text }
          })
        );
      } else if (metadata.phase === "signature" && typeof metadata.signature === "string") {
        controller.enqueue(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: state.thinkingIndex,
            delta: { type: "signature_delta", signature: metadata.signature }
          })
        );
      } else if (metadata.phase === "stop") {
        closeThinking(controller, metadata.index);
      }
    }
    return carriedText;
  };

  const process = (controller: Controller, chunk: OpenAiChunk): void => {
    if (chunk.error !== undefined && chunk.error !== null) {
      finalizeUpstreamError(controller, chunk.error);
      return;
    }
    const choice = chunk.choices?.[0];
    if (choice === undefined) {
      if (chunk.usage?.inputTokens !== undefined) state.inputTokens = chunk.usage.inputTokens;
      if (chunk.usage?.outputTokens !== undefined) state.outputTokens = chunk.usage.outputTokens;
      return;
    }
    const delta = choice.delta ?? {};
    const nativeDetails = anthropicReasoningDetailsOf(delta.reasoning_details, "stream");
    const nativeCarriedText =
      nativeDetails.length > 0 && handleReasoningDetails(controller, nativeDetails);
    if (
      state.pendingNarration.length > 0 &&
      (!state.thinkingOpen || state.thinkingSourceIndex === undefined)
    ) {
      flushPendingNarration(controller);
    }

    if (
      typeof delta.reasoning_content === "string" &&
      delta.reasoning_content.length > 0 &&
      !state.outputStarted
    ) {
      if (state.thinkingOpen && state.thinkingSourceIndex !== undefined) {
        // Never contaminate provider-signed thinking with gateway narration:
        // the signature must continue to describe exactly the native text.
        state.pendingNarration.push(delta.reasoning_content);
      } else {
        emitNarration(controller, delta.reasoning_content);
      }
    }

    if (
      !nativeCarriedText &&
      typeof delta.reasoning === "string" &&
      delta.reasoning.length > 0 &&
      !state.outputStarted
    ) {
      // Raw model thinking tokens pass through verbatim: they are already
      // plain text, and Anthropic thinking blocks stream token deltas natively.
      ensureThinking(controller);
      controller.enqueue(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: state.thinkingIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning }
        })
      );
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      ensureText(controller);
      controller.enqueue(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: state.textIndex,
          delta: { type: "text_delta", text: delta.content }
        })
      );
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const indexKey = typeof call.index === "number" ? call.index : undefined;
        const idKey = typeof call.id === "string" && call.id.length > 0 ? call.id : undefined;
        let block =
          indexKey !== undefined
            ? toolBlockByIndex.get(indexKey)
            : idKey !== undefined
              ? toolBlockById.get(idKey)
              : lastToolBlock;
        if (block === undefined) {
          ensureStarted(controller);
          closeThinking(controller);
          flushPendingNarration(controller);
          closeThinking(controller);
          state.outputStarted = true;
          block = state.nextIndex++;
          toolBlocks.push(block);
          controller.enqueue(
            sse("content_block_start", {
              type: "content_block_start",
              index: block,
              content_block: {
                type: "tool_use",
                id: call.id ?? `toolu_${randomId()}`,
                name: call.function?.name ?? "",
                input: {}
              }
            })
          );
        }
        if (indexKey !== undefined && !toolBlockByIndex.has(indexKey))
          toolBlockByIndex.set(indexKey, block);
        if (idKey !== undefined && !toolBlockById.has(idKey)) toolBlockById.set(idKey, block);
        lastToolBlock = block;
        const args = call.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          controller.enqueue(
            sse("content_block_delta", {
              type: "content_block_delta",
              index: block,
              delta: { type: "input_json_delta", partial_json: args }
            })
          );
        }
      }
    }

    if (chunk.usage?.inputTokens !== undefined) state.inputTokens = chunk.usage.inputTokens;
    if (chunk.usage?.outputTokens !== undefined) state.outputTokens = chunk.usage.outputTokens;
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      finalize(
        controller,
        typeof choice.anthropic_stop_reason === "string"
          ? choice.anthropic_stop_reason
          : mapStopReason(choice.finish_reason),
        typeof choice.anthropic_stop_sequence === "string" ? choice.anthropic_stop_sequence : null
      );
    }
  };

  const handleEvent = (controller: Controller, data: string): void => {
    if (data.length === 0) return;
    if (data === "[DONE]") {
      // A `[DONE]` without a prior finish_reason is truncation, not a clean stop.
      if (!state.finished)
        finalizeTruncated(controller, "upstream sent [DONE] before a finish reason");
      return;
    }
    let chunk: OpenAiChunk;
    try {
      chunk = decodeOpenAiChatSseEvent(JSON.parse(data));
    } catch (error) {
      // The live upstream stream is authoritative: a malformed payload is a
      // stream error, never silently skipped (WS5). Surface it and stop.
      const detail = error instanceof Error ? error.message : String(error);
      throw new SseParseError(
        `malformed OpenAI SSE payload in Anthropic translation: ${detail}`,
        data.slice(0, 200)
      );
    }
    const marker = serverToolMarkerOf(chunk);
    if (marker !== undefined) {
      handleServerToolMarker(controller, marker);
      return;
    }
    process(controller, chunk);
  };

  return StreamPump.sse(upstream, {
    keepaliveMs: 3000,
    onStart(controller) {
      // Start the message immediately and keep the connection alive with `ping`
      // events while the upstream is still producing its first token. Claude
      // Code times out if it sees nothing during a slow upstream phase (the
      // chat-layer keepalive comments are dropped by this translator, so this
      // ping is the single keepalive that reaches the client).
      ensureStarted(controller);
    },
    keepalive(controller) {
      if (!state.finished) controller.enqueue(sse("ping", { type: "ping" }));
    },
    onEvent(event, controller) {
      handleEvent(controller, event.data);
    },
    onEnd(controller) {
      if (!state.finished) {
        finalizeTruncated(controller, "upstream stream ended before a finish reason");
      }
    }
  });
}
