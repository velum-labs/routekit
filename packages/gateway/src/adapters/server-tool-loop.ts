/**
 * The server-tool inner loop (gateway-executed web search).
 *
 * When the upstream model calls a *server-executed* tool (today: `web_search`),
 * nobody on the caller's side can answer it — the caller declared the tool
 * expecting the "server" to run it. This loop makes the gateway that server:
 * it intercepts server-tool calls from a model step, executes them via a
 * {@link WebSearchExecutor}, appends the exchange to the chat transcript, and
 * runs another model step — repeating until a step commits to something the
 * caller can actually handle (text, client tool calls, or a clean stop).
 *
 * The loop operates at the chat-completions layer, around `backend.chat`:
 * each inner step is an ordinary backend turn, exactly as
 * if the caller had executed a client tool and come back. The dialect egress
 * translators stay single-stream: in streaming mode the loop composes the
 * steps' chat SSE into one continuous stream, suppressing the server-tool
 * fragments and injecting {@link ServerToolMarker} chunks (an in-process
 * convention) that the translators render as their dialect's native search
 * items (`web_search_call` / `server_tool_use` + `web_search_tool_result`).
 *
 * Mixed batches (server + client calls in one step) terminate the turn: the
 * client calls surface and the server calls are dropped un-executed — results
 * could not be fed back into a turn that just ended, and the upstream model can
 * simply re-issue the search next turn.
 */

import {
  extensionValue,
  type Reasoning,
  type ToolCall,
  type ToolCallAssemblyExtension,
  type ToolResult,
  type Usage
} from "@velum-labs/routekit-contracts/protocol-ir";
import { randomId } from "@velum-labs/routekit-runtime";
import {
  RouteKitFailure,
  runRouteKitEffect,
  runRouteKitEffectWith
} from "@velum-labs/routekit-runtime/effect";
import { StreamPump } from "@velum-labs/routekit-runtime/sse";
import { type Context, Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { BackendRequest } from "../backend.js";
import { gatewayTry, gatewayTryPromise } from "../effect/gateway.js";
import {
  decodeOpenAiChatResponse,
  decodeOpenAiChatSseEvent,
  decodeOpenAiToolCalls,
  isProviderRecord,
  type OpenAiChatResponse
} from "../provider-protocol.js";
import { ChatStreamAssembler } from "../sse/chat-assembler.js";
import { SseParseError } from "../sse/parse.js";
import {
  googleToolCallIndexesOf,
  type ResponsesReasoningState,
  responsesReasoningMetadataOf
} from "./openai-chat-wire.js";
import {
  canonicalServerToolReasoning,
  nativeAnthropicServerToolReasoning,
  serverToolAssistantMessage
} from "./server-tool-transcript.js";
import type { WebSearchExecutor } from "./web-search.js";
import { MAX_WEB_SEARCHES_PER_TURN } from "./web-search.js";

const ENCODER = new TextEncoder();

/** Absolute bound on model steps per caller turn (defense against a model that
 *  keeps searching after being told the search budget is exhausted). */
const MAX_LOOP_STEPS = 16;

/** In-process marker chunk field the loop injects between composed steps. */
export const SERVER_TOOL_MARKER_FIELD = "routekit_server_tool";

export type ServerToolMarker = {
  kind: "web_search";
  phase: "start" | "done";
  item_id: string;
  query: string;
  status?: "completed" | "failed";
  /** Anthropic-native result blocks for the Anthropic egress (done phase). */
  result_blocks?: unknown[];
};

/** The marker on a parsed chat chunk, if present. */
export function serverToolMarkerOf(chunk: unknown): ServerToolMarker | undefined {
  if (chunk === null || typeof chunk !== "object") return undefined;
  const marker = (chunk as Record<string, unknown>)[SERVER_TOOL_MARKER_FIELD];
  return marker !== null && typeof marker === "object" ? (marker as ServerToolMarker) : undefined;
}

export type ExecutedSearch = {
  itemId: string;
  query: string;
  status: "completed" | "failed";
  result?: ToolResult;
};

export type ServerToolLoopEvent =
  | { kind: "reasoning"; details: Reasoning[] }
  | { kind: "search"; search: ExecutedSearch };

export type ServerToolLoopOptions = {
  /** The translated chat body; the loop appends search exchanges to `messages`. */
  chat: Record<string, unknown>;
  runStep: (chat: Record<string, unknown>) => BackendRequest;
  serverToolNames: ReadonlySet<string>;
  executor: WebSearchExecutor;
  maxSearches?: number;
  signal?: AbortSignal;
  platform?: Context.Context<HttpClient.HttpClient>;
};

type RawToolCall = {
  index?: unknown;
  id?: string;
  function?: { name?: string; arguments?: string };
};

function callName(call: { name?: string } | RawToolCall): string {
  return "function" in call && call.function !== undefined
    ? (call.function.name ?? "")
    : ((call as { name?: string }).name ?? "");
}

function queryOf(args: string | undefined): string {
  if (args === undefined || args.trim().length === 0) return "";
  try {
    const parsed = JSON.parse(args) as { query?: unknown };
    return typeof parsed.query === "string" ? parsed.query : args;
  } catch {
    return args;
  }
}

function renderSearchResult(search: ExecutedSearch): string {
  if (search.status === "failed" || search.result === undefined) {
    return `[web_search_error] the search could not be executed${
      search.result?.content !== undefined && search.result.content.length > 0
        ? `: ${search.result.content}`
        : ""
    }. Answer from what you already know, or try a different query.`;
  }
  const sources = search.result.citations.map(
    (citation) => `- ${citation.url}${citation.title !== undefined ? ` (${citation.title})` : ""}`
  );
  return sources.length > 0
    ? `${search.result.content}\n\nSources:\n${sources.join("\n")}`
    : search.result.content;
}

function anthropicSearchResultBlocks(result: ToolResult | undefined): unknown[] | undefined {
  const blocks = result?.extensions?.find(
    (extension) => extension.namespace === "anthropic.web-search-results"
  )?.value;
  return Array.isArray(blocks) && blocks.length > 0 ? blocks : undefined;
}

const LIMIT_MESSAGE =
  "[web_search_limit] the web search budget for this turn is exhausted; answer with the information you already have.";

function chatMessages(chat: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(chat.messages)) chat.messages = [];
  return chat.messages as Record<string, unknown>[];
}

/**
 * Execute one pure-server step's calls (respecting the remaining budget) and
 * append the assistant tool-call message + tool results to the transcript.
 * Emits `onSearch` start/done callbacks around each execution so the streaming
 * composer can inject markers live.
 */
function executeServerCalls(input: {
  options: ServerToolLoopOptions;
  calls: readonly {
    index?: number;
    providerIndex?: number;
    id?: string;
    name?: string;
    arguments?: string;
  }[];
  stepContent: string | undefined;
  reasoningDetails?: readonly Reasoning[];
  responsesReasoning?: ResponsesReasoningState;
  searches: ExecutedSearch[];
  onSearchStart?: (search: { itemId: string; query: string }) => void;
  onSearchDone?: (search: ExecutedSearch) => void;
}): Effect.Effect<void, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const { options, calls, searches } = input;
    const max = options.maxSearches ?? MAX_WEB_SEARCHES_PER_TURN;
    const messages = chatMessages(options.chat);
    const { assistant, toolCalls } = serverToolAssistantMessage({
      calls,
      stepContent: input.stepContent,
      reasoningDetails: input.reasoningDetails,
      responsesReasoning: input.responsesReasoning
    });
    messages.push(assistant);
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i];
      if (call === undefined) continue;
      const query = queryOf(call.arguments);
      const callId = toolCalls[i]?.id ?? `call_${randomId()}`;
      if (searches.length >= max) {
        messages.push({ role: "tool", tool_call_id: callId, content: LIMIT_MESSAGE });
        continue;
      }
      const itemId = `ws_${randomId()}`;
      yield* Effect.sync(() => input.onSearchStart?.({ itemId, query }));
      const search = yield* options.executor.search(query, options.signal).pipe(
        Effect.map(
          (result): ExecutedSearch => ({
            itemId,
            query,
            status: "completed",
            result
          })
        ),
        Effect.catch((error) =>
          Effect.succeed({
            itemId,
            query,
            status: "failed" as const,
            result: {
              content: error instanceof Error ? error.message : String(error),
              isError: true,
              citations: []
            }
          } satisfies ExecutedSearch)
        )
      );
      searches.push(search);
      yield* Effect.sync(() => input.onSearchDone?.(search));
      messages.push({ role: "tool", tool_call_id: callId, content: renderSearchResult(search) });
    }
  });
}

// ---- buffered mode ----

export type BufferedLoopOutcome =
  | {
      kind: "openai";
      openai: OpenAiChatResponse;
      searches: ExecutedSearch[];
      events: ServerToolLoopEvent[];
    }
  | { kind: "upstream_error"; response: Response };

/**
 * Run the loop over buffered (non-streaming) model steps. `firstStep` is the
 * already-awaited first model step (the handler surfaces its HTTP errors
 * before entering the loop). Returns the terminal step's OpenAI payload (with
 * any un-executable mixed-batch server calls stripped) plus the searches
 * executed along the way, for the dialect egress to render as native items.
 */
export function runBufferedServerToolLoop(
  options: ServerToolLoopOptions & { firstStep: Response }
): Effect.Effect<BufferedLoopOutcome, Error, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const searches: ExecutedSearch[] = [];
    const events: ServerToolLoopEvent[] = [];
    const totals: UsageTotals = { prompt: 0, completion: 0, seen: false };
    for (let step = 0; step < MAX_LOOP_STEPS; step += 1) {
      const upstream = step === 0 ? options.firstStep : yield* options.runStep(options.chat);
      if (!upstream.ok) return { kind: "upstream_error", response: upstream };
      const payload = yield* gatewayTryPromise(() => upstream.json());
      const openai = yield* gatewayTry(() => decodeOpenAiChatResponse(payload));
      accumulateUsage(totals, openai.usage);
      const choice = (Array.isArray(openai.choices) ? openai.choices[0] : undefined) as
        | {
            message?: {
              content?: unknown;
              reasoning_details?: Reasoning[];
              tool_calls?: unknown;
            };
            finish_reason?: unknown;
          }
        | undefined;
      const message = choice?.message;
      const calls = decodeOpenAiToolCalls(message?.tool_calls) as readonly RawToolCall[];
      const server = calls.filter((call) => options.serverToolNames.has(callName(call)));
      const client = calls.filter((call) => !options.serverToolNames.has(callName(call)));
      if (server.length === 0) {
        return {
          kind: "openai",
          openai: withAccumulatedUsage(openai, totals),
          searches,
          events
        };
      }
      if (client.length > 0 || typeof choice?.finish_reason !== "string") {
        if (message !== undefined) message.tool_calls = client;
        return {
          kind: "openai",
          openai: withAccumulatedUsage(openai, totals),
          searches,
          events
        };
      }
      const canonicalStepReasoning = canonicalServerToolReasoning(message?.reasoning_details);
      const stepReasoning = nativeAnthropicServerToolReasoning(canonicalStepReasoning);
      if (stepReasoning.length > 0) {
        events.push({ kind: "reasoning", details: stepReasoning });
      }
      const googleToolCallIndexes = googleToolCallIndexesOf(message);
      yield* executeServerCalls({
        options,
        calls: server.map((call) => ({
          ...(typeof call.index === "number" ? { index: call.index } : {}),
          ...(typeof call.id === "string" && Number.isInteger(googleToolCallIndexes[call.id])
            ? { providerIndex: googleToolCallIndexes[call.id] }
            : {}),
          id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments
        })),
        stepContent: typeof message?.content === "string" ? message.content : undefined,
        reasoningDetails: canonicalStepReasoning,
        responsesReasoning: responsesReasoningMetadataOf(message),
        searches,
        onSearchDone: (search) => events.push({ kind: "search", search })
      });
    }
    return {
      kind: "openai",
      openai: withAccumulatedUsage(
        {
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: LIMIT_MESSAGE },
              finish_reason: "stop"
            }
          ]
        },
        totals
      ),
      searches,
      events
    };
  });
}
// ---- streaming mode ----

type StepForwardState = {
  /** Suppressed (server-tool) fragment keys within the current step. */
  suppressedIndexes: Set<number>;
  suppressedIds: Set<string>;
  lastFragmentSuppressed: boolean;
  /** The step's finish chunk, held until the loop decides it is terminal. */
  heldFinishChunk: Record<string, unknown> | undefined;
};

function isFragmentSuppressed(
  state: StepForwardState,
  call: RawToolCall,
  serverToolNames: ReadonlySet<string>
): boolean {
  const index = typeof call.index === "number" ? call.index : undefined;
  const id = typeof call.id === "string" && call.id.length > 0 ? call.id : undefined;
  const name = call.function?.name;
  if (typeof name === "string" && name.length > 0) {
    const suppressed = serverToolNames.has(name);
    if (suppressed) {
      if (index !== undefined) state.suppressedIndexes.add(index);
      if (id !== undefined) state.suppressedIds.add(id);
    }
    state.lastFragmentSuppressed = suppressed;
    return suppressed;
  }
  const suppressed =
    index !== undefined
      ? state.suppressedIndexes.has(index)
      : id !== undefined
        ? state.suppressedIds.has(id)
        : state.lastFragmentSuppressed;
  state.lastFragmentSuppressed = suppressed;
  return suppressed;
}

function encodeChunk(chunk: Record<string, unknown>): Uint8Array {
  return ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

function markerChunk(marker: ServerToolMarker): Uint8Array {
  return encodeChunk({ [SERVER_TOOL_MARKER_FIELD]: marker });
}

type UsageTotals = { prompt: number; completion: number; seen: boolean };

function accumulateUsage(totals: UsageTotals, usage: unknown): void {
  if (usage === null || typeof usage !== "object") return;
  const source = usage as Usage;
  if (typeof source.inputTokens === "number") totals.prompt += source.inputTokens;
  if (typeof source.outputTokens === "number") totals.completion += source.outputTokens;
  totals.seen = true;
}

function withAccumulatedUsage(openai: OpenAiChatResponse, totals: UsageTotals): OpenAiChatResponse {
  if (!totals.seen) return openai;
  const existing =
    openai.usage !== null && typeof openai.usage === "object" && !Array.isArray(openai.usage)
      ? (openai.usage as Record<string, unknown>)
      : {};
  return {
    ...openai,
    usage: {
      ...existing,
      inputTokens: totals.prompt,
      outputTokens: totals.completion,
      totalTokens: totals.prompt + totals.completion
    }
  };
}

/**
 * Compose the loop's model steps into one continuous chat SSE stream.
 *
 * `firstStep` is the already-awaited first model step (the handler surfaces
 * its HTTP errors exactly as the single-step path does). Server-tool call
 * fragments are suppressed from the forwarded stream; each executed search is
 * injected as a pair of {@link ServerToolMarker} chunks for the dialect
 * translator. Per-step usage is withheld and re-emitted summed before the
 * terminal finish chunk, so the client-visible usage covers the whole loop.
 */
export function composeServerToolStream(
  options: ServerToolLoopOptions & { firstStep: Response }
): ReadableStream<Uint8Array> {
  const searches: ExecutedSearch[] = [];
  const totals: UsageTotals = { prompt: 0, completion: 0, seen: false };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const program = Effect.gen(function* () {
        let upstream: Response = options.firstStep;
        for (let step = 0; step < MAX_LOOP_STEPS; step += 1) {
          if (step > 0) {
            upstream = yield* options.runStep(options.chat);
            if (!upstream.ok) {
              const detail = yield* gatewayTryPromise(() => upstream.text());
              return yield* new RouteKitFailure({
                message: `model step failed mid web-search loop (${upstream.status}): ${detail.slice(0, 500)}`
              });
            }
          }
          const source = upstream.body;
          if (source === null) {
            return yield* new RouteKitFailure({
              message: "model step produced no stream mid web-search loop"
            });
          }
          const pumped = yield* gatewayTryPromise(() => pumpStep(controller, source));
          if (pumped.kind === "terminal") {
            controller.close();
            return;
          }
          yield* executeServerCalls({
            options,
            calls: pumped.calls,
            stepContent: pumped.stepContent,
            reasoningDetails: pumped.reasoningDetails,
            responsesReasoning: pumped.responsesReasoning,
            searches,
            onSearchStart: (search) => {
              controller.enqueue(
                markerChunk({
                  kind: "web_search",
                  phase: "start",
                  item_id: search.itemId,
                  query: search.query
                })
              );
            },
            onSearchDone: (search) => {
              controller.enqueue(
                markerChunk({
                  kind: "web_search",
                  phase: "done",
                  item_id: search.itemId,
                  query: search.query,
                  status: search.status,
                  ...(anthropicSearchResultBlocks(search.result) !== undefined
                    ? { result_blocks: anthropicSearchResultBlocks(search.result) }
                    : search.result !== undefined && search.status === "completed"
                      ? {
                          result_blocks: search.result.citations.map((citation) => ({
                            type: "web_search_result",
                            url: citation.url,
                            ...(citation.title !== undefined ? { title: citation.title } : {})
                          }))
                        }
                      : {})
                })
              );
            }
          });
        }
        // Step bound exhausted: close the turn rather than looping forever.
        finalize(controller, "stop");
        controller.close();
      });
      void (
        options.platform === undefined
          ? runRouteKitEffect(program)
          : runRouteKitEffectWith(options.platform, program)
      ).catch((error: unknown) => {
        controller.error(error);
      });
    }
  });

  /** Emit summed usage + a finish chunk + [DONE], ending the composed stream. */
  function finalize(
    controller: ReadableStreamDefaultController<Uint8Array>,
    finishReason: string,
    heldFinishChunk?: Record<string, unknown>
  ): void {
    if (totals.seen) {
      controller.enqueue(
        encodeChunk({
          choices: [],
          usage: {
            prompt_tokens: totals.prompt,
            completion_tokens: totals.completion,
            total_tokens: totals.prompt + totals.completion
          }
        })
      );
    }
    controller.enqueue(
      encodeChunk(
        heldFinishChunk ?? { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }
      )
    );
    controller.enqueue(ENCODER.encode("data: [DONE]\n\n"));
  }

  type PumpedStep =
    | { kind: "terminal" }
    | {
        kind: "continue";
        calls: Array<{
          index?: number;
          providerIndex?: number;
          id?: string;
          name?: string;
          arguments?: string;
        }>;
        stepContent: string | undefined;
        reasoningDetails: readonly Reasoning[] | undefined;
        responsesReasoning: ResponsesReasoningState | undefined;
      };

  /**
   * Forward one step's SSE into the composed stream. Returns `terminal` when the
   * step finished the turn; `continue` when the loop must run another model
   * step after executing the step's server-tool calls.
   */
  async function pumpStep(
    controller: ReadableStreamDefaultController<Uint8Array>,
    source: ReadableStream<Uint8Array>
  ): Promise<PumpedStep> {
    const assembler = new ChatStreamAssembler();
    const state: StepForwardState = {
      suppressedIndexes: new Set(),
      suppressedIds: new Set(),
      lastFragmentSuppressed: false,
      heldFinishChunk: undefined
    };
    let stepContent = "";

    const handleData = (data: string): void => {
      if (data.length === 0 || data === "[DONE]") return;
      let chunk: Record<string, unknown>;
      try {
        chunk = decodeOpenAiChatSseEvent(JSON.parse(data));
      } catch (error) {
        throw new SseParseError(
          `malformed OpenAI SSE payload in server-tool loop: ${
            error instanceof Error ? error.message : String(error)
          }`,
          data.slice(0, 200)
        );
      }
      assembler.pushParsed(chunk);
      let rewritten = chunk;
      if (chunk.usage !== undefined && chunk.usage !== null) {
        accumulateUsage(totals, chunk.usage);
        rewritten = { ...rewritten };
        delete rewritten.usage;
      }
      const rewrittenChoices = Array.isArray(rewritten.choices) ? rewritten.choices : [];
      const choice = isProviderRecord(rewrittenChoices[0]) ? rewrittenChoices[0] : undefined;
      const delta = isProviderRecord(choice?.delta) ? choice.delta : undefined;
      if (typeof delta?.content === "string") stepContent += delta.content;
      if (choice !== undefined && Array.isArray(delta?.tool_calls)) {
        const kept = decodeOpenAiToolCalls(delta.tool_calls).filter(
          (call) => !isFragmentSuppressed(state, call, options.serverToolNames)
        );
        if (kept.length !== delta.tool_calls.length) {
          rewritten = {
            ...rewritten,
            choices: [{ ...choice, delta: { ...delta, tool_calls: kept } }]
          };
          if (kept.length === 0) {
            rewritten = {
              ...rewritten,
              choices: [{ ...choice, delta: { ...delta, tool_calls: undefined } }]
            };
          }
        }
      }
      const finishReason = choice?.finish_reason;
      if (typeof finishReason === "string") {
        // Hold the finish: whether it surfaces depends on what the step
        // committed to (decided once the step's stream ends).
        state.heldFinishChunk = rewritten;
        return;
      }
      const survivingChoices = Array.isArray(rewritten.choices) ? rewritten.choices : [];
      const survivingChoice = isProviderRecord(survivingChoices[0])
        ? survivingChoices[0]
        : undefined;
      const survivingDelta = isProviderRecord(survivingChoice?.delta)
        ? survivingChoice.delta
        : undefined;
      const emptyDelta = survivingDelta !== undefined && Object.keys(survivingDelta).length === 0;
      const bareUsageChunk =
        chunk.usage !== undefined &&
        (rewritten.choices === undefined || (rewritten.choices as unknown[]).length === 0);
      if (emptyDelta || bareUsageChunk) return;
      controller.enqueue(encodeChunk(rewritten));
    };

    const transformed = StreamPump.sse(source, {
      signal: options.signal,
      onEvent(event) {
        handleData(event.data);
      },
      onEnd() {}
    });
    await transformed.pipeTo(new WritableStream<Uint8Array>({ write() {} }));

    const turn = assembler.result();
    const server = turn.toolCalls.filter((call) => options.serverToolNames.has(call.name));
    const client = turn.toolCalls.filter((call) => !options.serverToolNames.has(call.name));
    const pureServerStep =
      server.length > 0 && client.length === 0 && turn.finishReason !== undefined;

    if (!pureServerStep) {
      if (state.heldFinishChunk !== undefined) {
        finalize(controller, "stop", state.heldFinishChunk);
      } else if (turn.finishReason === undefined) {
        // Truncated upstream: end without a finish chunk so the translator
        // reports the turn as incomplete rather than fabricating completion.
        controller.enqueue(ENCODER.encode("data: [DONE]\n\n"));
      } else {
        finalize(controller, turn.finishReason);
      }
      return { kind: "terminal" };
    }

    return {
      kind: "continue",
      calls: server.map((call) => ({
        ...(() => {
          const assembly = extensionValue<
            ToolCallAssemblyExtension["namespace"],
            ToolCallAssemblyExtension["value"]
          >(call.extensions, "routekit.tool-call-assembly");
          return {
            ...(assembly?.index !== undefined ? { index: assembly.index } : {}),
            ...(assembly?.providerIndex !== undefined
              ? { providerIndex: assembly.providerIndex }
              : {})
          };
        })(),
        id: call.id,
        name: call.name,
        arguments:
          typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments)
      })),
      stepContent: stepContent.length > 0 ? stepContent : undefined,
      reasoningDetails: turn.reasoningDetails,
      responsesReasoning: turn.responsesReasoning
    };
  }
}
