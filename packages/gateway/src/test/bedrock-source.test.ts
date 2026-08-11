import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConverseCommand,
  ConverseStreamCommand
} from "@aws-sdk/client-bedrock-runtime";
import {
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand
} from "@aws-sdk/client-bedrock";

import {
  BedrockProviderSource,
  toBedrockConverseInput
} from "../bedrock-source.js";

test("Bedrock discovery includes active Anthropic foundations and paginated backed profiles", async () => {
  const commands: unknown[] = [];
  const source = new BedrockProviderSource({
    controlClient: {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof ListFoundationModelsCommand) return {
          modelSummaries: [
            {
              modelId: "anthropic.claude-3",
              providerName: "Anthropic",
              modelLifecycle: { status: "ACTIVE" },
              inputModalities: ["TEXT", "IMAGE"],
              outputModalities: ["TEXT"],
              responseStreamingSupported: true
            },
            {
              modelId: "anthropic.claude-opus-5",
              providerName: "Anthropic",
              modelLifecycle: { status: "ACTIVE" },
              inputModalities: ["TEXT"],
              outputModalities: ["TEXT"],
              responseStreamingSupported: true
            },
            { modelId: "anthropic.old", providerName: "Anthropic", modelLifecycle: { status: "LEGACY" } },
            { modelId: "amazon.titan", providerName: "Amazon", modelLifecycle: { status: "ACTIVE" } }
          ]
        };
        const token = (command as ListInferenceProfilesCommand).input.nextToken;
        return token === undefined ? {
          inferenceProfileSummaries: [
            { inferenceProfileId: "us.anthropic.claude-3", inferenceProfileName: "Claude", inferenceProfileArn: "arn:profile", status: "ACTIVE", type: "SYSTEM_DEFINED", createdAt: new Date("2026-07-09T00:00:00Z"), models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3" }] },
            { inferenceProfileId: "us.anthropic.claude-opus-5", inferenceProfileName: "Opus 5", inferenceProfileArn: "arn:profile-opus-5", status: "ACTIVE", type: "SYSTEM_DEFINED", models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5" }] },
            { inferenceProfileId: "us.amazon.titan", inferenceProfileName: "Titan", inferenceProfileArn: "arn:profile2", status: "ACTIVE", type: "SYSTEM_DEFINED", models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan" }] }
          ],
          nextToken: "page-2"
        } : {
          inferenceProfileSummaries: [
            { inferenceProfileId: "eu.anthropic.claude-3", inferenceProfileName: "Claude EU", inferenceProfileArn: "arn:profile3", status: "ACTIVE", type: "SYSTEM_DEFINED", models: [{ modelArn: "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-3" }] }
          ]
        };
      }
    } as never,
    runtimeClient: { send: async () => ({}) } as never
  });
  const discovered = await source.discoverModels();
  assert.deepEqual(discovered.map((model) => model.id), [
    "anthropic.claude-3",
    "anthropic.claude-opus-5",
    "us.anthropic.claude-3",
    "us.anthropic.claude-opus-5",
    "eu.anthropic.claude-3"
  ]);
  assert.deepEqual(discovered[0]?.metadata?.architecture, {
    modality: "text+image->text",
    inputModalities: ["text", "image"],
    outputModalities: ["text"]
  });
  assert.deepEqual(discovered[2]?.metadata, discovered[0]?.metadata);
  assert.ok(
    discovered.every(
      (model) => model.createdAt === undefined && model.providerPriority === undefined
    ),
    "profile creation time is not model recency"
  );
  assert.equal(discovered[0]?.capabilities?.streaming, "supported");
  assert.equal(discovered[0]?.reasoning, undefined);
  assert.deepEqual(discovered[1]?.reasoning, {
    status: "supported",
    efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
    adaptive: true,
    wireShape: "bedrock-converse",
    provenance: "builtin"
  });
  assert.deepEqual(discovered[3]?.reasoning, discovered[1]?.reasoning);
  assert.equal(commands.length, 3);
});

test("Bedrock request translation covers system, image, tools, results, and inference config", () => {
  const input = toBedrockConverseInput({
    model: "us.anthropic.claude-3",
    messages: [
      { role: "system", content: "Be terse" },
      { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } }] },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "found" }
    ],
    tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "lookup" } },
    max_completion_tokens: 256,
    temperature: 0.2,
    top_p: 0.9,
    top_k: 40,
    stop: ["END"]
  });
  assert.equal(input.modelId, "us.anthropic.claude-3");
  assert.deepEqual(input.system, [{ text: "Be terse" }]);
  assert.equal(input.messages?.length, 3);
  const image = input.messages?.[0]?.content?.[1];
  assert.equal(image !== undefined && "image" in image, true);
  assert.deepEqual(input.toolConfig?.toolChoice, { tool: { name: "lookup" } });
  assert.deepEqual(input.inferenceConfig, { maxTokens: 256, temperature: 0.2, topP: 0.9, stopSequences: ["END"] });
  assert.deepEqual(input.additionalModelRequestFields, { top_k: 40 });
});

test("Bedrock Opus 5 translates effort and adaptive reasoning controls", () => {
  assert.deepEqual(
    toBedrockConverseInput({
      model: "anthropic.claude-opus-5",
      messages: [],
      reasoning_effort: "high"
    }).additionalModelRequestFields,
    { thinking: { type: "adaptive" }, output_config: { effort: "high" } }
  );
  assert.deepEqual(
    toBedrockConverseInput({
      model: "us.anthropic.claude-opus-5",
      messages: [],
      x_routekit: { version: 1, selection: { mode: "adaptive" } }
    }).additionalModelRequestFields,
    { thinking: { type: "adaptive" } }
  );
  assert.deepEqual(
    toBedrockConverseInput({
      model: "anthropic.claude-opus-5",
      messages: [],
      x_routekit: { version: 1, selection: { mode: "budget", budgetTokens: 2048 } }
    }).additionalModelRequestFields,
    { thinking: { type: "enabled", budget_tokens: 2048 } }
  );
  assert.deepEqual(
    toBedrockConverseInput({
      model: "anthropic.claude-opus-5",
      messages: [],
      x_routekit: { version: 1, selection: { mode: "disabled" } }
    }).additionalModelRequestFields,
    { thinking: { type: "disabled" } }
  );
  assert.equal(
    toBedrockConverseInput({
      model: "anthropic.claude-opus-5",
      messages: []
    }).additionalModelRequestFields,
    undefined
  );
});

test("Bedrock maps profile-required Opus 5 foundations to a discovered inference profile", async () => {
  let command: ConverseCommand | undefined;
  const source = new BedrockProviderSource({
    controlClient: {
      send: async (value: unknown) => {
        if (value instanceof ListFoundationModelsCommand) {
          return {
            modelSummaries: [{
              modelId: "anthropic.claude-opus-5",
              providerName: "Anthropic",
              modelLifecycle: { status: "ACTIVE" }
            }]
          };
        }
        return {
          inferenceProfileSummaries: [{
            inferenceProfileId: "us.anthropic.claude-opus-5",
            status: "ACTIVE",
            models: [{
              modelArn: "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-opus-5"
            }]
          }]
        };
      }
    } as never,
    runtimeClient: {
      send: async (value: unknown) => {
        command = value as ConverseCommand;
        return {
          $metadata: { requestId: "req-opus-5" },
          output: { message: { role: "assistant", content: [{ text: "OK" }] } },
          stopReason: "end_turn"
        };
      }
    } as never
  });

  await source.discoverModels();
  const response = await source.chat({
    model: "anthropic.claude-opus-5",
    messages: [{ role: "user", content: "Reply with exactly OK." }],
    reasoning_effort: "low"
  });
  assert.equal(response.status, 200);
  assert.equal(command instanceof ConverseCommand, true);
  assert.equal(command?.input.modelId, "us.anthropic.claude-opus-5");
  assert.equal((await response.json() as { model?: string }).model, "anthropic.claude-opus-5");
});

test("Bedrock Converse maps text, reasoning, tools, stop, and usage", async () => {
  let command: unknown;
  const source = new BedrockProviderSource({
    controlClient: { send: async () => ({}) } as never,
    runtimeClient: { send: async (value: unknown) => {
      command = value;
      return {
        $metadata: { requestId: "req-1" },
        output: { message: { role: "assistant", content: [
          { reasoningContent: { reasoningText: { text: "thinking", signature: "sig" } } },
          { text: "answer" },
          { toolUse: { toolUseId: "call_1", name: "lookup", input: { q: "x" } } }
        ] } },
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 }
      };
    } } as never
  });
  const response = await source.chat({ model: "anthropic.claude-3", messages: [{ role: "user", content: "hi" }] });
  assert.equal(command instanceof ConverseCommand, true);
  const body = await response.json() as any;
  assert.equal(body.choices[0].message.content, "answer");
  assert.equal(body.choices[0].message.reasoning, "thinking");
  assert.deepEqual(body.choices[0].message.reasoning_details, [{
    text: "thinking",
    extensions: [{ namespace: "anthropic.reasoning", value: { index: 0, signature: "sig" } }]
  }]);
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, "{\"q\":\"x\"}");
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(body.usage, { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
});

test("Bedrock ConverseStream emits OpenAI SSE tool deltas, text, usage, stop, and done", async () => {
  let command: unknown;
  async function* events() {
    yield { messageStart: { role: "assistant" } };
    yield { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "call_1", name: "lookup" } } } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{\"q\":" } } } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "\"x\"}" } } } };
    yield { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "answer" } } };
    yield { messageStop: { stopReason: "tool_use" } };
    yield { metadata: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } };
  }
  const source = new BedrockProviderSource({
    controlClient: { send: async () => ({}) } as never,
    runtimeClient: { send: async (value: unknown) => { command = value; return { stream: events() }; } } as never
  });
  const response = await source.chat({ model: "anthropic.claude-3", stream: true, messages: [{ role: "user", content: "hi" }] });
  assert.equal(command instanceof ConverseStreamCommand, true);
  const text = await response.text();
  const data = text.split("\n\n").flatMap((event): Array<Record<string, any>> => {
    if (!event.startsWith("data: ") || event === "data: [DONE]") return [];
    return [JSON.parse(event.slice("data: ".length)) as Record<string, any>];
  });
  const deltas = data.map((event) => event.choices?.[0]?.delta ?? {});
  const toolDeltas = deltas.flatMap((delta) => delta.tool_calls ?? []);
  assert.equal(toolDeltas[0]?.id, "call_1");
  assert.equal(toolDeltas.map((delta) => delta.function?.arguments ?? "").join(""), "{\"q\":\"x\"}");
  assert.equal(deltas.map((delta) => delta.content ?? "").join(""), "answer");
  assert.equal(data.some((event) => event.choices?.[0]?.finish_reason === "tool_calls"), true);
  assert.deepEqual(data.find((event) => event.usage !== undefined)?.usage, {
    prompt_tokens: 2, completion_tokens: 3, total_tokens: 5
  });
  assert.match(text, /data: \[DONE\]/);
  assert.equal((await source.embeddings()).status, 501);
});

test("Bedrock source forwards abort signals to SDK clients", async () => {
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  const source = new BedrockProviderSource({
    controlClient: { send: async (_command: unknown, options?: { abortSignal?: AbortSignal }) => { observed = options?.abortSignal; return { modelSummaries: [{ modelId: "anthropic.claude", providerName: "Anthropic", modelLifecycle: { status: "ACTIVE" } }] }; } } as never,
    runtimeClient: { send: async () => ({}) } as never
  });
  await source.discoverModels(controller.signal);
  assert.equal(observed, controller.signal);
});


test("Bedrock stream maps provider errors and honors abort without live AWS access", async () => {
  async function* failingEvents() {
    yield { serviceUnavailableException: { message: "temporarily unavailable" } };
  }
  const failing = new BedrockProviderSource({
    controlClient: { send: async () => ({}) } as never,
    runtimeClient: { send: async () => ({ stream: failingEvents() }) } as never
  });
  const failed = await (await failing.chat({ model: "anthropic.claude", stream: true, messages: [] })).text();
  assert.match(failed, /"type":"provider_error"/);
  assert.match(failed, /temporarily unavailable/);
  assert.match(failed, /data: \[DONE\]/);

  const controller = new AbortController();
  async function* waitingEvents() {
    controller.abort();
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ignored" } } };
  }
  const aborting = new BedrockProviderSource({
    controlClient: { send: async () => ({}) } as never,
    runtimeClient: { send: async () => ({ stream: waitingEvents() }) } as never
  });
  const aborted = await (await aborting.chat(
    { model: "anthropic.claude", stream: true, messages: [] }, controller.signal
  )).text();
  assert.doesNotMatch(aborted, /ignored|provider_error|\[DONE\]/);
});


test("Bedrock buffered reasoning metadata replays exactly through tool continuation", async () => {
  const inputs: any[] = [];
  let invocation = 0;
  const source = new BedrockProviderSource({
    controlClient: { send: async () => ({}) } as never,
    runtimeClient: { send: async (command: any) => {
      inputs.push(command.input);
      invocation += 1;
      return invocation === 1 ? {
        $metadata: {},
        output: { message: { role: "assistant", content: [
          { reasoningContent: { reasoningText: { text: "private thought", signature: "bedrock-signature" } } },
          { toolUse: { toolUseId: "call_1", name: "lookup", input: { q: "x" } } }
        ] } },
        stopReason: "tool_use"
      } : {
        $metadata: {}, output: { message: { role: "assistant", content: [{ text: "done" }] } },
        stopReason: "end_turn"
      };
    } } as never
  });
  const first = await (await source.chat({
    model: "anthropic.claude", messages: [{ role: "user", content: "lookup" }]
  })).json() as any;
  const assistant = first.choices[0].message;
  assert.deepEqual(assistant.reasoning_details, [{
    text: "private thought",
    extensions: [{
      namespace: "anthropic.reasoning",
      value: { index: 0, signature: "bedrock-signature" }
    }]
  }]);
  await source.chat({
    model: "anthropic.claude",
    messages: [
      { role: "user", content: "lookup" },
      assistant,
      { role: "tool", tool_call_id: "call_1", content: "result" }
    ]
  });
  assert.deepEqual(inputs[1].messages[1].content[0], {
    reasoningContent: { reasoningText: { text: "private thought", signature: "bedrock-signature" } }
  });
  assert.deepEqual(inputs[1].messages[1].content[1], {
    toolUse: { toolUseId: "call_1", name: "lookup", input: { q: "x" } }
  });
});

test("Bedrock streamed reasoning metadata assembles and replays exactly", async () => {
  let secondInput: any;
  async function* stream() {
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "private " } } } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "thought" } } } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "stream-signature" } } } };
    yield { contentBlockStop: { contentBlockIndex: 0 } };
    yield { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call_1", name: "lookup" } } } };
    yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: "{}" } } } };
    yield { messageStop: { stopReason: "tool_use" } };
  }
  let invocation = 0;
  const source = new BedrockProviderSource({
    controlClient: { send: async () => ({}) } as never,
    runtimeClient: { send: async (command: any) => {
      invocation += 1;
      if (invocation === 1) return { stream: stream() };
      secondInput = command.input;
      return { $metadata: {}, output: { message: { role: "assistant", content: [{ text: "done" }] } }, stopReason: "end_turn" };
    } } as never
  });
  const wire = await (await source.chat({
    model: "anthropic.claude", stream: true, messages: [{ role: "user", content: "lookup" }]
  })).text();
  const chunks = wire.split("\n\n").flatMap((event): any[] =>
    event.startsWith("data: {") ? [JSON.parse(event.slice(6))] : []
  );
  const assembler = new (await import("../sse/chat-assembler.js")).ChatStreamAssembler();
  for (const chunk of chunks) assembler.pushParsed(chunk);
  const turn = assembler.result();
  assert.equal(turn.reasoning, "private thought");
  assert.deepEqual(turn.reasoningDetails, [{
    text: "private thought",
    extensions: [{
      namespace: "anthropic.reasoning",
      value: { index: 0, signature: "stream-signature" }
    }]
  }]);
  await source.chat({
    model: "anthropic.claude",
    messages: [
      { role: "user", content: "lookup" },
      {
        role: "assistant", content: turn.content, reasoning: turn.reasoning,
        reasoning_details: turn.reasoningDetails,
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.id, type: "function",
          function: { name: call.name, arguments: call.arguments }
        }))
      },
      { role: "tool", tool_call_id: "call_1", content: "result" }
    ]
  });
  assert.deepEqual(secondInput.messages[1].content[0], {
    reasoningContent: { reasoningText: { text: "private thought", signature: "stream-signature" } }
  });
});

test("Bedrock groups parallel tool results into one user message", () => {
  const input = toBedrockConverseInput({
    model: "anthropic.claude",
    messages: [
      { role: "user", content: "both" },
      { role: "assistant", content: "", tool_calls: [
        { id: "call_1", function: { name: "one", arguments: "{}" } },
        { id: "call_2", function: { name: "two", arguments: "{}" } }
      ] },
      { role: "tool", tool_call_id: "call_1", content: "first" },
      { role: "tool", tool_call_id: "call_2", content: "second" }
    ]
  });
  assert.equal(input.messages?.length, 3);
  assert.deepEqual(input.messages?.[2], {
    role: "user",
    content: [
      { toolResult: { toolUseId: "call_1", content: [{ text: "first" }] } },
      { toolResult: { toolUseId: "call_2", content: [{ text: "second" }] } }
    ]
  });
});

test("Bedrock defaults reasoning to unknown and ordinary requests omit thinking", () => {
  const source = new BedrockProviderSource({
    controlClient: { send: async () => ({}) } as never,
    runtimeClient: { send: async () => ({}) } as never
  });
  assert.equal(source.reasoningCapabilities("anthropic.claude-opus-5")?.status, "supported");
  assert.deepEqual(source.reasoningCapabilities(), {
    status: "unknown", wireShape: "bedrock-converse", provenance: "provider"
  });
  assert.equal(toBedrockConverseInput({
    model: "anthropic.claude", messages: [], reasoning_effort: "high"
  }).additionalModelRequestFields, undefined);
  assert.equal(toBedrockConverseInput({
    model: "anthropic.claude", messages: [], reasoning_effort: "none"
  }).additionalModelRequestFields, undefined);
});
