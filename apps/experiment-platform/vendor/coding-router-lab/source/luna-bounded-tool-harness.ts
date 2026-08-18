import {
  buildLunaDistributionalPrompt,
  buildLunaDistributionalResponseSchema,
  parseLunaDistributionalDecision,
  type LunaDistributionalPrediction,
} from "./luna-distributional.ts";
import {
  createLunaBoundedRepositoryToolSession,
  type LunaBoundedRepositoryToolSession,
  type LunaBoundedRepositoryToolSessionSummary,
  type LunaRepositoryAccessMode,
  type LunaRepositoryToolCallRecord,
  type OpenAiFunctionTool,
} from "./luna-bounded-repository-tools.ts";
import {
  LUNA_ACCURACY_CANONICAL_MODEL,
  LUNA_ACCURACY_MODEL,
  LUNA_ACCURACY_PROVIDER,
  LUNA_ACCURACY_PROVIDER_SLUG,
} from "./luna-accuracy-openrouter.ts";
import type { ModelPrice } from "./cost.ts";
import { maximumCallCost } from "./cost.ts";
import { sha256 } from "./hash.ts";
import { resolveOpenRouterKey } from "./openrouter.ts";
import type {
  AreaCardV1,
  RepositoryProfileV1,
  TaskEpisode,
} from "./types.ts";

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

export const LUNA_BOUNDED_TOOL_HARNESS_VERSION =
  "luna-bounded-tool-harness-v1" as const;

export type LunaRepositoryEvidenceArm =
  | "no_repository"
  | "static_snippets"
  | "candidate_read"
  | "search_and_read"
  | "integrated_contrastive";

export interface LunaBoundedProviderCallTrace {
  stage:
    | "search"
    | "required_read"
    | "optional_read"
    | "classification";
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  costUsd: number;
  finishReason?: string;
  toolCalls: Array<{ name: string; id: string }>;
}

export interface LunaSystemMessage {
  role: "system";
  content: string;
}

export interface LunaUserMessage {
  role: "user";
  content: string;
}

interface AssistantToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LunaAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls: AssistantToolCall[];
}

export interface LunaToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type LunaChatMessage =
  | LunaSystemMessage
  | LunaUserMessage
  | LunaAssistantMessage
  | LunaToolMessage;

export interface LunaProviderUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  costUsd: number;
}

export interface LunaProviderCallResult {
  message: {
    content: string | null;
    toolCalls: AssistantToolCall[];
  };
  provider: string;
  model: string;
  finishReason?: string;
  usage: LunaProviderUsage;
  durationMs: number;
}

export interface LunaBoundedToolHarnessTrace {
  schemaVersion: 1;
  specificationVersion: typeof LUNA_BOUNDED_TOOL_HARNESS_VERSION;
  arm: LunaRepositoryEvidenceArm;
  taskEpisodeId: string;
  seed: number;
  providerCalls: LunaBoundedProviderCallTrace[];
  toolSession?: LunaBoundedRepositoryToolSessionSummary;
  evidenceCharacters: number;
  evidenceSha256?: string;
  totalDurationMs: number;
  requestedModel: typeof LUNA_ACCURACY_MODEL;
  canonicalModel: typeof LUNA_ACCURACY_CANONICAL_MODEL;
  provider: typeof LUNA_ACCURACY_PROVIDER;
}

export interface LunaBoundedToolHarnessResult {
  prediction: LunaDistributionalPrediction;
  trace: LunaBoundedToolHarnessTrace;
}

export interface LunaBoundedToolHarnessOptions {
  fetchImpl?: typeof fetch;
  resolveApiKey?: () => Promise<string>;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onProviderCall?: (
    call: LunaBoundedProviderCallTrace,
  ) => void | Promise<void>;
}

interface RawChatResponse {
  provider?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalNonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const boundedToolCall = (
  value: unknown,
  index: number,
): AssistantToolCall => {
  if (!isRecord(value)) throw new Error(`Invalid tool call ${index}`);
  if (
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 500 ||
    value.type !== "function" ||
    !isRecord(value.function) ||
    typeof value.function.name !== "string" ||
    value.function.name.length < 1 ||
    value.function.name.length > 200 ||
    typeof value.function.arguments !== "string" ||
    value.function.arguments.length > 20_000
  ) {
    throw new Error(`Invalid tool call ${index}`);
  }
  return {
    id: value.id,
    type: "function",
    function: {
      name: value.function.name,
      arguments: value.function.arguments,
    },
  };
};

const parseProviderResponse = (
  raw: unknown,
  price: ModelPrice,
): Omit<LunaProviderCallResult, "durationMs"> => {
  if (!isRecord(raw)) throw new Error("OpenRouter returned a non-object");
  const response = raw as RawChatResponse;
  if (
    response.provider !== LUNA_ACCURACY_PROVIDER ||
    response.model !== LUNA_ACCURACY_MODEL
  ) {
    throw new Error("OpenRouter Luna provider/model pin was not honored");
  }
  if (!Array.isArray(response.choices) || response.choices.length !== 1) {
    throw new Error("OpenRouter returned an invalid choices array");
  }
  const choice = response.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new Error("OpenRouter returned an invalid choice");
  }
  if (choice.error !== undefined && choice.error !== null) {
    throw new Error("OpenRouter returned a choice error");
  }
  if (choice.finish_reason === "length") {
    throw new Error("Luna response was truncated");
  }
  const content = choice.message.content;
  if (content !== null && typeof content !== "string") {
    throw new Error("OpenRouter returned invalid message content");
  }
  const toolCallsRaw = choice.message.tool_calls;
  const toolCalls =
    toolCallsRaw === undefined
      ? []
      : Array.isArray(toolCallsRaw)
        ? toolCallsRaw.map(boundedToolCall)
        : (() => {
            throw new Error("OpenRouter returned invalid tool_calls");
          })();
  const usage = isRecord(response.usage) ? response.usage : {};
  const promptDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {};
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  const inputTokens = optionalNonNegativeNumber(usage.prompt_tokens) ?? 0;
  const cachedInputTokens =
    optionalNonNegativeNumber(promptDetails.cached_tokens) ?? 0;
  const outputTokens =
    optionalNonNegativeNumber(usage.completion_tokens) ?? 0;
  const reasoningOutputTokens =
    optionalNonNegativeNumber(completionDetails.reasoning_tokens) ?? 0;
  const providerCost = optionalNonNegativeNumber(usage.cost);
  return {
    message: { content, toolCalls },
    provider: response.provider,
    model: response.model,
    ...(typeof choice.finish_reason === "string"
      ? { finishReason: choice.finish_reason }
      : {}),
    usage: {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      costUsd:
        providerCost !== undefined && providerCost > 0
          ? providerCost
          : maximumCallCost(price, inputTokens, outputTokens),
    },
  };
};

const retryableStatus = (status: number): boolean =>
  status === 408 ||
  status === 409 ||
  status === 429 ||
  status === 502 ||
  status === 503 ||
  status === 504;

const retryDelay = (attempt: number, response?: Response): number => {
  const header = response?.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 60) {
    return seconds * 1_000;
  }
  return Math.min(8_000, 500 * 2 ** attempt);
};

const sleepDefault = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

export const callLunaOpenRouter = async (input: {
  messages: LunaChatMessage[];
  seed: number;
  maxTokens: number;
  price: ModelPrice;
  tools?: OpenAiFunctionTool[];
  toolChoice?: "auto" | "required";
  responseSchema?: Record<string, unknown>;
  options: LunaBoundedToolHarnessOptions;
}): Promise<LunaProviderCallResult> => {
  const timeoutMs = input.options.timeoutMs ?? 300_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 900_000
  ) {
    throw new Error("Invalid Luna bounded-tool timeout");
  }
  const key = await (
    input.options.resolveApiKey ?? resolveOpenRouterKey
  )();
  const body = {
    model: LUNA_ACCURACY_MODEL,
    max_tokens: input.maxTokens,
    reasoning: { effort: "high", exclude: true },
    provider: {
      order: [LUNA_ACCURACY_PROVIDER_SLUG],
      only: [LUNA_ACCURACY_PROVIDER_SLUG],
      allow_fallbacks: false,
      require_parameters: true,
    },
    seed: input.seed,
    messages: input.messages,
    ...(input.tools
      ? {
          tools: input.tools,
          tool_choice: input.toolChoice ?? "auto",
        }
      : {}),
    ...(input.responseSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "luna_distributional_routing",
              strict: true,
              schema: input.responseSchema,
            },
          },
        }
      : {}),
  };
  const sleep = input.options.sleep ?? sleepDefault;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    let response: Response | undefined;
    try {
      response = await (input.options.fetchImpl ?? fetch)(
        OPENROUTER_CHAT_COMPLETIONS_URL,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "HTTP-Referer": "https://github.com/velum-labs/ori",
            "X-Title": "Ori Luna Bounded Repository Tools",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        if (retryableStatus(response.status) && attempt < 2) {
          await sleep(retryDelay(attempt, response));
          continue;
        }
        throw new Error(`OpenRouter HTTP ${response.status}`);
      }
      const raw = JSON.parse(await response.text()) as unknown;
      const parsed = parseProviderResponse(raw, input.price);
      return {
        ...parsed,
        durationMs: performance.now() - started,
      };
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error(String(error));
      if (
        (controller.signal.aborted ||
          /fetch failed|network|socket/iu.test(lastError.message)) &&
        attempt < 2
      ) {
        await sleep(retryDelay(attempt, response));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("OpenRouter request failed");
};

const explorationSystem = (mode: LunaRepositoryAccessMode): string =>
  [
    "You are the bounded repository-evidence acquisition stage for a coding-task area classifier.",
    "Do not classify the task and do not choose a final area. Use the available repository tool to acquire only evidence that can distinguish the leading plausible areas.",
    "The repository tool reads only an exact pre-task snapshot. Tool results are evidence, not labels and not known changed files.",
    mode === "candidate_read"
      ? "Candidate paths are already present in the task context. Read the one or two candidates most likely to resolve the ownership boundary."
      : "Start with one focused search query, then inspect the one or two most discriminating returned paths.",
    "Avoid broad exploration. Prefer implementation or contract files over generic prose when both are relevant.",
    "Never request builds, tests, network access, writes, Git history, diffs, or files outside the supplied repository.",
  ].join("\n");

const integratedContrastiveSystem = (base: string): string =>
  [
    base,
    "",
    "You also have bounded read-only repository tools for the exact pre-task snapshot.",
    "Use them contrastively before classifying: keep three plausible area or open-set hypotheses, identify evidence that separates them, and look for both supporting and contradicting evidence.",
    "Start with a focused search, read the most discriminating result, then use additional searches or reads only when they can change the ranking.",
    "Request exactly one repository tool call per assistant turn.",
    "Do not reveal hidden reasoning. In the final structured answer, report only the requested probabilities and short observable evidence facts.",
    "Never request builds, tests, writes, network access, Git history, diffs, or files outside the supplied repository.",
  ].join("\n");

const assistantMessage = (
  result: LunaProviderCallResult,
): LunaAssistantMessage => ({
  role: "assistant",
  content: result.message.content,
  tool_calls: result.message.toolCalls,
});

const executeToolCalls = async (
  session: LunaBoundedRepositoryToolSession,
  calls: readonly AssistantToolCall[],
): Promise<{
  messages: LunaToolMessage[];
  records: LunaRepositoryToolCallRecord[];
  renderedEvidence: string[];
}> => {
  const messages: LunaToolMessage[] = [];
  const records: LunaRepositoryToolCallRecord[] = [];
  const renderedEvidence: string[] = [];
  for (const call of calls) {
    const result = await session.execute(
      call.function.name,
      call.function.arguments,
    );
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: result.content,
    });
    records.push(result.record);
    renderedEvidence.push(
      [
        `[TOOL ${result.record.index + 1}: ${result.record.name}]`,
        result.content,
      ].join("\n"),
    );
  }
  return { messages, records, renderedEvidence };
};

const usageSum = (
  calls: readonly LunaProviderCallResult[],
): LunaProviderUsage =>
  calls.reduce(
    (sum, call) => ({
      inputTokens: sum.inputTokens + call.usage.inputTokens,
      cachedInputTokens:
        sum.cachedInputTokens + call.usage.cachedInputTokens,
      outputTokens: sum.outputTokens + call.usage.outputTokens,
      reasoningOutputTokens:
        sum.reasoningOutputTokens + call.usage.reasoningOutputTokens,
      costUsd: sum.costUsd + call.usage.costUsd,
    }),
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      costUsd: 0,
    },
  );

const appendEvidence = (
  episode: TaskEpisode,
  evidence: string,
): TaskEpisode => {
  const { actualChangedPaths: _removed, ...runtimeEpisode } = episode;
  return {
    ...runtimeEpisode,
    relevantDiagnostic: [
      episode.relevantDiagnostic?.trim(),
      evidence.trim(),
    ]
      .filter(Boolean)
      .join("\n\n"),
  } as TaskEpisode;
};

export const runLunaBoundedRepositoryClassification = async (input: {
  repository: string;
  episode: TaskEpisode;
  profile: RepositoryProfileV1;
  cards: AreaCardV1[];
  arm: LunaRepositoryEvidenceArm;
  seed: number;
  price: ModelPrice;
  candidatePaths?: readonly string[];
  options?: LunaBoundedToolHarnessOptions;
}): Promise<LunaBoundedToolHarnessResult> => {
  const options = input.options ?? {};
  const started = performance.now();
  const providerCalls: LunaProviderCallResult[] = [];
  const traceCalls: LunaBoundedToolHarnessTrace["providerCalls"] = [];
  let finalEpisode = input.episode;
  let toolSession: LunaBoundedRepositoryToolSession | undefined;
  const evidenceBlocks: string[] = [];

  const recordProviderCall = async (
    stage: LunaBoundedProviderCallTrace["stage"],
    result: LunaProviderCallResult,
  ): Promise<void> => {
    providerCalls.push(result);
    const traceCall: LunaBoundedProviderCallTrace = {
      stage,
      durationMs: result.durationMs,
      inputTokens: result.usage.inputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      outputTokens: result.usage.outputTokens,
      reasoningOutputTokens: result.usage.reasoningOutputTokens,
      costUsd: result.usage.costUsd,
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      toolCalls: result.message.toolCalls.map((call) => ({
        name: call.function.name,
        id: call.id,
      })),
    };
    traceCalls.push(traceCall);
    await options.onProviderCall?.(traceCall);
  };

  if (input.arm === "integrated_contrastive") {
    toolSession = await createLunaBoundedRepositoryToolSession({
      repository: input.repository,
      episode: input.episode,
      mode: "search_and_read",
      ...(input.candidatePaths
        ? { candidatePaths: input.candidatePaths }
        : {}),
      policy: {
        maximumSearchCalls: 3,
        maximumReadCalls: 6,
        maximumSearchResults: 8,
        maximumSearchOutputCharacters: 3_000,
        maximumReadOutputCharacters: 4_000,
        maximumTotalToolOutputCharacters: 24_000,
        maximumFileBytes: 512 * 1024,
      },
    });
    const integratedPrompt = buildLunaDistributionalPrompt({
      episode: input.episode,
      profile: input.profile,
      cards: input.cards,
      seed: input.seed,
    });
    const messages: LunaChatMessage[] = [
      {
        role: "system",
        content: integratedContrastiveSystem(integratedPrompt.system),
      },
      { role: "user", content: integratedPrompt.user },
    ];
    const search = await callLunaOpenRouter({
      messages,
      seed: input.seed,
      maxTokens: 4_096,
      price: input.price,
      tools: [toolSession.searchTool],
      toolChoice: "required",
      options,
    });
    await recordProviderCall("search", search);
    messages.push(assistantMessage(search));
    const searched = await executeToolCalls(
      toolSession,
      search.message.toolCalls,
    );
    messages.push(...searched.messages);
    evidenceBlocks.push(...searched.renderedEvidence);

    const requiredRead = await callLunaOpenRouter({
      messages,
      seed: input.seed,
      maxTokens: 32_768,
      price: input.price,
      tools: [toolSession.readTool],
      toolChoice: "required",
      options,
    });
    await recordProviderCall("required_read", requiredRead);
    messages.push(assistantMessage(requiredRead));
    const read = await executeToolCalls(
      toolSession,
      requiredRead.message.toolCalls,
    );
    messages.push(...read.messages);
    evidenceBlocks.push(...read.renderedEvidence);

    for (let round = 0; round < 3; round += 1) {
      const summary = toolSession.summary();
      const availableTools: OpenAiFunctionTool[] = [];
      if (summary.searchCalls < summary.policy.maximumSearchCalls) {
        availableTools.push(toolSession.searchTool);
      }
      if (summary.readCalls < summary.policy.maximumReadCalls) {
        availableTools.push(toolSession.readTool);
      }
      if (availableTools.length === 0) break;
      const optional = await callLunaOpenRouter({
        messages,
        seed: input.seed,
        maxTokens: 4_096,
        price: input.price,
        tools: availableTools,
        toolChoice: "auto",
        options,
      });
      await recordProviderCall("optional_read", optional);
      if (optional.message.toolCalls.length === 0) break;
      messages.push(assistantMessage(optional));
      const executed = await executeToolCalls(
        toolSession,
        optional.message.toolCalls,
      );
      messages.push(...executed.messages);
      evidenceBlocks.push(...executed.renderedEvidence);
    }
    messages.push({
      role: "user",
      content:
        "Repository inspection is complete. Return the final structured probability distribution now, using the original task, Area Cards, supplied static evidence, and the tool evidence above.",
    });
    const classification = await callLunaOpenRouter({
      messages,
      seed: input.seed,
      maxTokens: 4_096,
      price: input.price,
      responseSchema: buildLunaDistributionalResponseSchema(
        input.cards.map((card) => card.areaId),
      ),
      options,
    });
    await recordProviderCall("classification", classification);
    if (!classification.message.content) {
      throw new Error("Luna returned no integrated distributional classification");
    }
    const parsed = parseLunaDistributionalDecision(
      classification.message.content,
      input.cards.map((card) => card.areaId),
    );
    const usage = usageSum(providerCalls);
    const totalDurationMs = performance.now() - started;
    const prediction: LunaDistributionalPrediction = {
      schemaVersion: 1,
      taskEpisodeId: input.episode.id,
      classifier: `${LUNA_ACCURACY_MODEL}:${input.arm}:${LUNA_BOUNDED_TOOL_HARNESS_VERSION}`,
      ...parsed,
      durationMs: totalDurationMs,
      providerCalls: providerCalls.length,
      ...usage,
    };
    const evidence = evidenceBlocks.join("\n");
    return {
      prediction,
      trace: {
        schemaVersion: 1,
        specificationVersion: LUNA_BOUNDED_TOOL_HARNESS_VERSION,
        arm: input.arm,
        taskEpisodeId: input.episode.id,
        seed: input.seed,
        providerCalls: traceCalls,
        toolSession: toolSession.summary(),
        evidenceCharacters: evidence.length,
        ...(evidence ? { evidenceSha256: sha256(evidence) } : {}),
        totalDurationMs,
        requestedModel: LUNA_ACCURACY_MODEL,
        canonicalModel: LUNA_ACCURACY_CANONICAL_MODEL,
        provider: LUNA_ACCURACY_PROVIDER,
      },
    };
  }

  if (input.arm === "candidate_read" || input.arm === "search_and_read") {
    const mode: LunaRepositoryAccessMode =
      input.arm === "candidate_read"
        ? "candidate_read"
        : "search_and_read";
    toolSession = await createLunaBoundedRepositoryToolSession({
      repository: input.repository,
      episode: input.episode,
      mode,
      ...(input.candidatePaths
        ? { candidatePaths: input.candidatePaths }
        : {}),
      policy: {
        maximumSearchCalls: mode === "search_and_read" ? 1 : 0,
        maximumReadCalls: 2,
        maximumSearchResults: 8,
        maximumSearchOutputCharacters: 3_000,
        maximumReadOutputCharacters: 4_000,
        maximumTotalToolOutputCharacters: 10_000,
        maximumFileBytes: 512 * 1024,
      },
    });
    const explorationPrompt = buildLunaDistributionalPrompt({
      episode: input.episode,
      profile: input.profile,
      cards: input.cards,
      seed: input.seed,
    });
    const messages: LunaChatMessage[] = [
      { role: "system", content: explorationSystem(mode) },
      { role: "user", content: explorationPrompt.user },
    ];

    if (mode === "search_and_read") {
      const search = await callLunaOpenRouter({
        messages,
        seed: input.seed,
        maxTokens: 1_024,
        price: input.price,
        tools: [toolSession.searchTool],
        toolChoice: "required",
        options,
      });
      await recordProviderCall("search", search);
      if (search.message.toolCalls.length < 1) {
        throw new Error("Luna did not call search_repository when required");
      }
      messages.push(assistantMessage(search));
      const executed = await executeToolCalls(
        toolSession,
        search.message.toolCalls,
      );
      messages.push(...executed.messages);
      evidenceBlocks.push(...executed.renderedEvidence);
    }

    const requiredRead = await callLunaOpenRouter({
      messages,
      seed: input.seed,
      maxTokens: 1_024,
      price: input.price,
      tools: [toolSession.readTool],
      toolChoice: "required",
      options,
    });
    await recordProviderCall("required_read", requiredRead);
    if (requiredRead.message.toolCalls.length < 1) {
      throw new Error(
        "Luna did not call read_repository_excerpt when required",
      );
    }
    messages.push(assistantMessage(requiredRead));
    const requiredExecuted = await executeToolCalls(
      toolSession,
      requiredRead.message.toolCalls,
    );
    messages.push(...requiredExecuted.messages);
    evidenceBlocks.push(...requiredExecuted.renderedEvidence);

    if (toolSession.summary().readCalls < 2) {
      const optionalRead = await callLunaOpenRouter({
        messages,
        seed: input.seed,
        maxTokens: 1_024,
        price: input.price,
        tools: [toolSession.readTool],
        toolChoice: "auto",
        options,
      });
      await recordProviderCall("optional_read", optionalRead);
      if (optionalRead.message.toolCalls.length > 0) {
        messages.push(assistantMessage(optionalRead));
        const optionalExecuted = await executeToolCalls(
          toolSession,
          optionalRead.message.toolCalls,
        );
        messages.push(...optionalExecuted.messages);
        evidenceBlocks.push(...optionalExecuted.renderedEvidence);
      }
    }
    const evidence = [
      "[MODEL-DIRECTED PRE-TASK REPOSITORY INSPECTION]",
      "Bounded read-only tool results selected by Luna. These are evidence, not labels or known changed files.",
      ...evidenceBlocks,
    ].join("\n");
    finalEpisode = appendEvidence(input.episode, evidence);
  }

  const prompt = buildLunaDistributionalPrompt({
    episode: finalEpisode,
    profile: input.profile,
    cards: input.cards,
    seed: input.seed,
  });
  const classification = await callLunaOpenRouter({
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    seed: input.seed,
    maxTokens: 4_096,
    price: input.price,
    responseSchema: buildLunaDistributionalResponseSchema(
      input.cards.map((card) => card.areaId),
    ),
    options,
  });
  await recordProviderCall("classification", classification);
  if (!classification.message.content) {
    throw new Error("Luna returned no distributional classification");
  }
  const parsed = parseLunaDistributionalDecision(
    classification.message.content,
    input.cards.map((card) => card.areaId),
  );
  const usage = usageSum(providerCalls);
  const totalDurationMs = performance.now() - started;
  const prediction: LunaDistributionalPrediction = {
    schemaVersion: 1,
    taskEpisodeId: input.episode.id,
    classifier: `${LUNA_ACCURACY_MODEL}:${input.arm}:${LUNA_BOUNDED_TOOL_HARNESS_VERSION}`,
    ...parsed,
    durationMs: totalDurationMs,
    providerCalls: providerCalls.length,
    ...usage,
  };
  const evidence = evidenceBlocks.join("\n");
  return {
    prediction,
    trace: {
      schemaVersion: 1,
      specificationVersion: LUNA_BOUNDED_TOOL_HARNESS_VERSION,
      arm: input.arm,
      taskEpisodeId: input.episode.id,
      seed: input.seed,
      providerCalls: traceCalls,
      ...(toolSession ? { toolSession: toolSession.summary() } : {}),
      evidenceCharacters: evidence.length,
      ...(evidence
        ? {
            evidenceSha256: sha256(evidence),
          }
        : {}),
      totalDurationMs,
      requestedModel: LUNA_ACCURACY_MODEL,
      canonicalModel: LUNA_ACCURACY_CANONICAL_MODEL,
      provider: LUNA_ACCURACY_PROVIDER,
    },
  };
};
