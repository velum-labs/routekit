import { randomId } from "@velum-labs/routekit-runtime";

import { copyFailure, jsonResponse } from "./http-response.js";
import type { BackendRequestOptions } from "./backend.js";
import {
  bodyRecord,
  chatCompletion,
  HttpProviderBackend,
  invalidReasoningControlResponse,
  mapSse,
  textContent,
  type ChatBody,
  type ChatMessage,
  type ProviderBackendOptions
} from "./provider-backend-core.js";
import { joinPath } from "./backend.js";
import {
  attachGoogleToolCallIndexes,
  googleReasoningExtension,
  googleThoughtDetailsOf,
  googleToolCallIndexesOf,
  reasoningSelectionOf,
  routeKitRequestValidationErrorOf
} from "./adapters/openai-chat-wire.js";
import type { Reasoning } from "./protocol-ir.js";
import {
  decodeGoogleGenerateContent,
  isProviderRecord,
  ProviderProtocolError
} from "./provider-protocol.js";
function googleThoughtDetail(
  part: Record<string, unknown>,
  index: number
): Reasoning | undefined {
  if (typeof part.thoughtSignature !== "string" || part.thoughtSignature.length === 0) {
    return undefined;
  }
  return {
    ...(part.thought === true && typeof part.text === "string" ? { text: part.text } : {}),
    extensions: [{
      namespace: "google.reasoning",
      value: { index, thoughtSignature: part.thoughtSignature }
    }]
  };
}

function googleAssistantParts(message: ChatMessage): Array<Record<string, unknown>> {
  const details = googleThoughtDetailsOf(message.reasoning_details);
  const detailsByIndex = new Map(
    details.flatMap((detail) => {
      const metadata = googleReasoningExtension(detail);
      return metadata === undefined ? [] : [[metadata.index, detail] as const];
    })
  );
  const privateIndexes = googleToolCallIndexesOf(message);
  const callsByIndex = new Map(
    (message.tool_calls ?? []).flatMap((call, fallbackIndex) => {
      const index =
        typeof call.id === "string" && Number.isInteger(privateIndexes[call.id])
          ? (privateIndexes[call.id] as number)
          : Number.isInteger((call as { index?: unknown }).index)
            ? ((call as { index: number }).index)
            : fallbackIndex;
      return [[index, call] as const];
    })
  );
  if (details.length === 0) {
    const parts: Array<Record<string, unknown>> = [];
    const text = textContent(message.content);
    if (text.length > 0) parts.push({ text });
    for (const call of message.tool_calls ?? []) parts.push(googleFunctionCallPart(call));
    return parts;
  }

  const parts: Array<Record<string, unknown>> = [];
  const text = textContent(message.content);
  let textAdded = false;
  const addText = (): void => {
    if (!textAdded && text.length > 0) parts.push({ text });
    textAdded = true;
  };
  const consumedCalls = new Set<NonNullable<ChatMessage["tool_calls"]>[number]>();
  for (const index of [...new Set([...detailsByIndex.keys(), ...callsByIndex.keys()])].sort((a, b) => a - b)) {
    const detail = detailsByIndex.get(index);
    const call = callsByIndex.get(index);
    const metadata = detail === undefined ? undefined : googleReasoningExtension(detail);
    if (typeof detail?.text === "string") {
      parts.push({ text: detail.text, thought: true, thoughtSignature: metadata?.thoughtSignature });
    } else if (call !== undefined) {
      addText();
      parts.push({
        ...googleFunctionCallPart(call),
        ...(metadata !== undefined ? { thoughtSignature: metadata.thoughtSignature } : {})
      });
      consumedCalls.add(call);
    }
  }
  addText();
  for (const call of message.tool_calls ?? []) {
    if (!consumedCalls.has(call)) parts.push(googleFunctionCallPart(call));
  }
  return parts;
}

function googleFunctionCallPart(
  call: NonNullable<ChatMessage["tool_calls"]>[number]
): Record<string, unknown> {
  let args: unknown = {};
  try {
    args = JSON.parse(call.function?.arguments ?? "{}");
  } catch {
    args = { raw: call.function?.arguments ?? "" };
  }
  return { functionCall: { name: call.function?.name ?? "tool", args } };
}

function googleRequest(body: ChatBody): Record<string, unknown> {
  const systemText = (body.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => textContent(message.content))
    .join("\n\n");
  const toolNames = new Map<string, string>();
  for (const message of body.messages ?? []) {
    for (const call of message.tool_calls ?? []) {
      if (call.id !== undefined && call.function?.name !== undefined) {
        toolNames.set(call.id, call.function.name);
      }
    }
  }
  const reasoning = reasoningSelectionOf(body);
  const thinkingConfig =
    reasoning.mode === "effort"
      ? { thinkingLevel: reasoning.effort }
      : reasoning.mode === "budget"
        ? { thinkingBudget: reasoning.budgetTokens }
        : reasoning.mode === "adaptive"
          ? { thinkingBudget: -1 }
          : reasoning.mode === "disabled"
            ? { thinkingBudget: 0 }
            : undefined;
  return {
    contents: (body.messages ?? []).flatMap((message) => {
      if (message.role === "system") return [];
      if (message.role === "tool") {
        return [{ role: "user", parts: [{ functionResponse: {
          name: toolNames.get(message.tool_call_id ?? "") ?? "tool",
          response: { output: textContent(message.content) }
        } }] }];
      }
      const parts = message.role === "assistant"
        ? googleAssistantParts(message)
        : textContent(message.content).length > 0
          ? [{ text: textContent(message.content) }]
          : [];
      return [{ role: message.role === "assistant" ? "model" : "user", parts }];
    }),
    ...(systemText.length > 0
      ? { systemInstruction: { role: "system", parts: [{ text: systemText }] } }
      : {}),
    generationConfig: {
      ...(body.max_tokens !== undefined ? { maxOutputTokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(thinkingConfig !== undefined ? { thinkingConfig } : {})
    },
    ...(body.tools !== undefined ? { tools: [{ functionDeclarations: body.tools.flatMap((tool) =>
      tool.function === undefined ? [] : [{
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters
      }]) }] } : {})
  };
}

type GoogleStreamToolPart = {
  providerIndex: number;
  toolIndex: number;
  id: string;
};

type GoogleStreamPartState = {
  nextProviderIndex: number;
  nextToolIndex: number;
  openThoughtIndex?: number;
  toolParts: Map<string, GoogleStreamToolPart>;
  thoughtText: Map<number, string>;
};

function googleFunctionIdentity(call: Record<string, unknown>): string | undefined {
  const providerId = call.id ?? call.callId ?? call.functionCallId;
  return typeof providerId === "string" && providerId.length > 0
    ? `id:${providerId}`
    : undefined;
}

function googleMessage(
  payload: Record<string, unknown>,
  streamState?: GoogleStreamPartState
): Record<string, unknown> {
  const decoded = decodeGoogleGenerateContent(payload);
  const content = isProviderRecord(decoded.candidates[0]?.content)
    ? decoded.candidates[0].content
    : undefined;
  const parts = (Array.isArray(content?.parts) ? content.parts : []).map((part) => {
    if (!isProviderRecord(part)) {
      throw new ProviderProtocolError(
        "google",
        "generate-content response",
        "content part must be an object",
        part
      );
    }
    return part;
  });
  let bufferedToolIndex = 0;
  const indexedParts: Array<{
    part: Record<string, unknown>;
    detailPart: Record<string, unknown>;
    providerIndex: number;
    toolIndex?: number;
    id?: string;
  }> = parts.map((part, localIndex) => {
    const call = part.functionCall as Record<string, unknown> | undefined;
    if (streamState === undefined) {
      return {
        part,
        detailPart: part,
        providerIndex: localIndex,
        ...(call !== undefined ? { toolIndex: bufferedToolIndex++ } : {})
      };
    }
    if (call !== undefined) {
      streamState.openThoughtIndex = undefined;
      const identity = googleFunctionIdentity(call);
      let toolPart = identity === undefined ? undefined : streamState.toolParts.get(identity);
      if (toolPart === undefined) {
        toolPart = {
          providerIndex: streamState.nextProviderIndex++,
          toolIndex: streamState.nextToolIndex++,
          id: randomId(12, "call_")
        };
        if (identity !== undefined) streamState.toolParts.set(identity, toolPart);
      }
      return { part, detailPart: part, ...toolPart };
    }
    if (part.thought === true) {
      const signature =
        typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0
          ? part.thoughtSignature
          : undefined;
      let providerIndex = streamState.openThoughtIndex;
      if (providerIndex === undefined) {
        providerIndex = streamState.nextProviderIndex++;
        streamState.openThoughtIndex = providerIndex;
      }
      const priorText = streamState.thoughtText.get(providerIndex) ?? "";
      const incomingText = typeof part.text === "string" ? part.text : "";
      const thought = `${priorText}${incomingText}`;
      streamState.thoughtText.set(providerIndex, thought);
      if (signature !== undefined) streamState.openThoughtIndex = undefined;
      return {
        part,
        detailPart:
          signature !== undefined
            ? { ...part, thought: true, text: thought, thoughtSignature: signature }
            : part,
        providerIndex
      };
    }
    streamState.openThoughtIndex = undefined;
    return { part, detailPart: part, providerIndex: streamState.nextProviderIndex++ };
  });
  const text = indexedParts
    .filter(({ part }) => part.thought === undefined || part.thought === false)
    .map(({ part }) => typeof part.text === "string" ? part.text : "")
    .join("");
  const reasoning = indexedParts
    .filter(({ part }) => part.thought === true)
    .map(({ part }) => typeof part.text === "string" ? part.text : "")
    .join("");
  const reasoningDetails = indexedParts.flatMap(({ detailPart, providerIndex }) => {
    const detail = googleThoughtDetail(detailPart, providerIndex);
    return detail === undefined ? [] : [detail];
  });
  const toolCalls = indexedParts.flatMap(({ part, providerIndex, toolIndex, id }) => {
    const call = part.functionCall as Record<string, unknown> | undefined;
    return call === undefined || toolIndex === undefined ? [] : [{
      id: id ?? randomId(12, "call_"),
      type: "function",
      index: toolIndex,
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      providerIndex
    }];
  });
  const message: Record<PropertyKey, unknown> = {
    role: "assistant",
    content: text,
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
    ...(toolCalls.length > 0
      ? {
          tool_calls: toolCalls.map(({ providerIndex: _providerIndex, ...call }) => call)
        }
      : {})
  };
  const providerIndexes = Object.fromEntries(
    toolCalls.map((call) => [call.id, call.providerIndex])
  );
  if (Object.keys(providerIndexes).length > 0) {
    attachGoogleToolCallIndexes(message, providerIndexes);
  }
  return message;
}
export class GoogleGenAiBackend extends HttpProviderBackend {
  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const validationError = routeKitRequestValidationErrorOf(body);
    if (validationError !== undefined) {
      return Promise.resolve(
        invalidReasoningControlResponse(
          validationError.message,
          validationError.code === "invalid_reasoning_metadata",
          validationError.path
        )
      );
    }
    return this.#chat(bodyRecord(body), signal, options);
  }

  async #chat(
    body: ChatBody,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const model = body.model ?? this.defaultModel ?? "";
    const method = body.stream === true ? "streamGenerateContent" : "generateContent";
    const response = await this.transport(
      `${joinPath(this.baseUrl, `/models/${encodeURIComponent(model)}:${method}`)}${
        body.stream === true ? "?alt=sse" : ""
      }`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
          ...this.extraHeaders
        },
        body: JSON.stringify(googleRequest(body)),
        ...(signal !== undefined ? { signal } : {})
      },
      options
    );
    if (!response.ok) return copyFailure(response, await response.text());
    if (body.stream === true) {
      const streamState: GoogleStreamPartState = {
        nextProviderIndex: 0,
        nextToolIndex: 0,
        toolParts: new Map(),
        thoughtText: new Map()
      };
      return mapSse(response, (_event, payload) => {
        const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
        const finishReason = candidates?.[0]?.finishReason;
        const usage = isProviderRecord(payload.usageMetadata)
          ? payload.usageMetadata
          : undefined;
        return [
          {
            id: randomId(18, "chatcmpl_"),
            object: "chat.completion.chunk",
            model,
            choices: [
              {
                index: 0,
                delta: googleMessage(payload, streamState),
                finish_reason:
                  finishReason === undefined
                    ? null
                    : finishReason === "MAX_TOKENS"
                      ? "length"
                      : "stop"
              }
            ],
            ...(usage !== undefined
              ? {
                  usage: {
                    prompt_tokens: usage.promptTokenCount,
                    completion_tokens: usage.candidatesTokenCount,
                    total_tokens: usage.totalTokenCount
                  }
                }
              : {})
          }
        ];
      }, (data) => decodeGoogleGenerateContent(data));
    }
    const payload = decodeGoogleGenerateContent(await response.json());
    const usage = isProviderRecord(payload.usageMetadata) ? payload.usageMetadata : undefined;
    return jsonResponse(
      chatCompletion(model, googleMessage(payload), {
        prompt_tokens: usage?.promptTokenCount,
        completion_tokens: usage?.candidatesTokenCount,
        total_tokens: usage?.totalTokenCount
      })
    );
  }
}
