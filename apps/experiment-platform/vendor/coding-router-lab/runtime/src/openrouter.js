import { readFile } from "node:fs/promises";
import path from "node:path";
const API_BASE = "https://openrouter.ai/api/v1";
export const resolveOpenRouterKey = async () => {
    const inherited = process.env.OPENROUTER_API_KEY?.trim();
    if (inherited)
        return inherited;
    const file = path.join(process.env.HOME ?? "", ".ori", "credentials.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    if (!stored.key?.trim())
        throw new Error("No OpenRouter credential found");
    return stored.key;
};
export const getOpenRouterKeyStatus = async () => {
    const response = await fetch(`${API_BASE}/key`, { headers: { authorization: `Bearer ${await resolveOpenRouterKey()}` } });
    const text = await response.text();
    if (!response.ok)
        throw new Error(`OpenRouter key status HTTP ${response.status}: ${text.slice(0, 1000)}`);
    const payload = JSON.parse(text);
    const data = payload.data ?? {};
    let accountUsageUsd = null, accountRemainingUsd = null;
    try {
        const creditsResponse = await fetch(`${API_BASE}/credits`, { headers: { authorization: `Bearer ${await resolveOpenRouterKey()}` } });
        if (creditsResponse.ok) {
            const credits = await creditsResponse.json();
            const totalCredits = Number(credits.data?.total_credits);
            const totalUsage = Number(credits.data?.total_usage);
            if (Number.isFinite(totalUsage))
                accountUsageUsd = totalUsage;
            if (Number.isFinite(totalCredits) && Number.isFinite(totalUsage))
                accountRemainingUsd = totalCredits - totalUsage;
        }
    }
    catch { }
    return {
        usageUsd: Number(data.usage ?? 0),
        limitUsd: data.limit ?? null,
        limitRemainingUsd: data.limit_remaining ?? null,
        accountUsageUsd,
        accountRemainingUsd,
        isFreeTier: data.is_free_tier ?? null,
        ...(data.label ? { label: data.label } : {}),
    };
};
const headers = async () => ({
    authorization: `Bearer ${await resolveOpenRouterKey()}`,
    "content-type": "application/json",
    "HTTP-Referer": "https://github.com/velum-labs/ori",
    "X-Title": "Ori Coding Router Lab",
});
const requestJson = async (url, body) => {
    const response = await fetch(url, { method: "POST", headers: await headers(), body: JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok)
        throw new Error(`OpenRouter HTTP ${response.status}: ${text.slice(0, 1000)}`);
    return JSON.parse(text);
};
export const embedTexts = async (model, inputs) => {
    const payload = await requestJson(`${API_BASE}/embeddings`, { model, input: inputs.map((item) => item.text), encoding_format: "float" });
    const vectors = payload.data.sort((a, b) => a.index - b.index).map((item, index) => ({ id: inputs[index].id, values: item.embedding }));
    return { vectors, ...(payload.usage?.total_tokens !== undefined ? { usageTokens: payload.usage.total_tokens } : {}) };
};
const unknownTypes = [
    "new_repository_area",
    "outside_scope",
    "insufficient_information",
];
const predictionSchemas = {
    minimal: {
        type: "object",
        additionalProperties: false,
        required: ["selectedAreaIds", "known", "unknownType", "confidence"],
        properties: {
            selectedAreaIds: {
                type: "array",
                maxItems: 2,
                items: { type: "string" },
            },
            known: { type: "boolean" },
            unknownType: {
                anyOf: [
                    { type: "string", enum: unknownTypes },
                    { type: "null" },
                ],
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
        },
    },
    lean: {
        type: "object",
        additionalProperties: false,
        required: [
            "selectedAreaIds",
            "known",
            "unknownType",
            "confidence",
            "reason",
        ],
        properties: {
            selectedAreaIds: {
                type: "array",
                maxItems: 2,
                items: { type: "string" },
            },
            known: { type: "boolean" },
            unknownType: {
                anyOf: [
                    { type: "string", enum: unknownTypes },
                    { type: "null" },
                ],
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
        },
    },
    verbose: {
        type: "object",
        additionalProperties: false,
        required: [
            "selectedAreaIds",
            "known",
            "unknownType",
            "confidence",
            "reason",
            "evidence",
        ],
        properties: {
            selectedAreaIds: {
                type: "array",
                maxItems: 2,
                items: { type: "string" },
            },
            known: { type: "boolean" },
            unknownType: {
                anyOf: [
                    { type: "string", enum: unknownTypes },
                    { type: "null" },
                ],
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
            evidence: {
                type: "array",
                maxItems: 4,
                items: { type: "string" },
            },
        },
    },
};
const directSystemPrompt = "You are the runtime task-area classifier for a personalized coding router. Select zero, one, or two known area IDs. Return unknown rather than forcing a weak match. Do not choose a coding model. Use only IDs supplied by the user.";
const gatedSystemPrompt = `${directSystemPrompt}

Classify in this strict order:
1. Decide whether the visible task context is sufficient to identify concrete work.
2. Decide whether the concrete work fits the supplied registry. A plausible but unsupported nearby area is unknown.
3. Only then choose one or two IDs. Choose two only when both are materially required.

For unknown work, set unknownType to:
- insufficient_information when the visible task-aware context does not identify concrete work;
- outside_scope when the request is not repository work;
- new_repository_area when it is repository work but no supplied area is a valid fit.

Confidence measures confidence in the complete decision, including the known-versus-unknown gate.`;
const noveltyStrictSystemPrompt = `${gatedSystemPrompt}

Treat Area Cards as bounded product-area definitions, not loose topical hints.
Return new_repository_area when a repository task introduces a cross-cutting
foundation, architecture, subsystem, or responsibility that is not explicitly
included in the supplied cards—even when parts of the implementation would
touch known areas. A task that merely touches known paths is not necessarily a
known-area task. Do not decompose a genuinely new cross-cutting area into the
nearest existing IDs just to avoid unknown.`;
const outputInstruction = (mode) => mode === "minimal"
    ? "Return only the structured decision. Do not add an explanation."
    : mode === "lean"
        ? "Keep reason to one short factual sentence."
        : "Briefly state the decision and up to four concrete task/registry clues. Do not reveal hidden reasoning.";
const buildLunaMessages = (input) => {
    const system = input.decisionMode === "novelty_strict"
        ? noveltyStrictSystemPrompt
        : input.decisionMode === "gated"
            ? gatedSystemPrompt
            : directSystemPrompt;
    const registry = `[AREA REGISTRY]\nAllowed area IDs: ${input.allowedAreaIds.join(", ")}\n\n${input.areaCards}`;
    const task = `[TASK-AWARE CONTEXT]\n${input.taskEnvelope}`;
    return [
        {
            role: "system",
            content: `${system}\n\n${outputInstruction(input.outputMode)}`,
        },
        {
            role: "user",
            content: input.promptOrder === "registry_first"
                ? `${registry}\n\n${task}`
                : `${task}\n\n${registry}`,
        },
    ];
};
export const classifyWithLuna = async (input) => {
    const promptOrder = input.promptOrder ?? "task_first";
    const decisionMode = input.decisionMode ?? "direct";
    const outputMode = input.outputMode ?? "lean";
    const reasoningEffort = input.reasoningEffort ?? "low";
    const messages = buildLunaMessages({
        taskEnvelope: input.taskEnvelope,
        areaCards: input.areaCards,
        allowedAreaIds: input.allowedAreaIds,
        promptOrder,
        decisionMode,
        outputMode,
    });
    const started = performance.now();
    const response = await requestJson(`${API_BASE}/chat/completions`, {
        model: input.model,
        temperature: 0,
        max_tokens: input.maxOutputTokens ?? 400,
        reasoning: { effort: reasoningEffort },
        messages,
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "task_area_prediction",
                strict: true,
                schema: predictionSchemas[outputMode],
            },
        },
    });
    const content = response.choices[0]?.message.content;
    if (!content)
        throw new Error("Luna returned no content");
    const parsed = JSON.parse(content);
    if (new Set(parsed.selectedAreaIds).size !== parsed.selectedAreaIds.length) {
        throw new Error("Luna repeated an area ID");
    }
    for (const id of parsed.selectedAreaIds) {
        if (!input.allowedAreaIds.includes(id)) {
            throw new Error(`Luna invented area ID ${id}`);
        }
    }
    if (parsed.known !== (parsed.selectedAreaIds.length > 0)) {
        throw new Error("Luna known flag conflicts with selected areas");
    }
    if (parsed.known && parsed.unknownType !== null) {
        throw new Error("Luna returned unknownType for a known decision");
    }
    if (!parsed.known && !parsed.unknownType) {
        throw new Error("Luna omitted unknownType for an unknown decision");
    }
    const inputCharacters = messages.reduce((sum, message) => sum + message.content.length, 0);
    return {
        schemaVersion: 1,
        taskEpisodeId: input.taskEpisodeId,
        classifier: input.classifierLabel ?? `llm:${input.model}`,
        areaScores: [],
        selectedAreaIds: parsed.selectedAreaIds,
        known: parsed.known,
        ...(!parsed.known && parsed.unknownType
            ? { unknownType: parsed.unknownType }
            : {}),
        confidence: parsed.confidence,
        ...(!parsed.known
            ? {
                abstentionReason: parsed.reason ??
                    parsed.unknownType ??
                    "runtime_classifier_abstention",
            }
            : {}),
        durationMs: performance.now() - started,
        inputCharacters,
        ...(response.usage?.prompt_tokens !== undefined
            ? { inputTokens: response.usage.prompt_tokens }
            : {}),
        ...(response.usage?.prompt_tokens_details?.cached_tokens !== undefined
            ? {
                cachedInputTokens: response.usage.prompt_tokens_details.cached_tokens,
            }
            : {}),
        ...(response.usage?.completion_tokens !== undefined
            ? { outputTokens: response.usage.completion_tokens }
            : {}),
        ...(response.usage?.completion_tokens_details?.reasoning_tokens !== undefined
            ? {
                reasoningOutputTokens: response.usage.completion_tokens_details.reasoning_tokens,
            }
            : {}),
        ...(response.usage?.cost !== undefined
            ? { costUsd: response.usage.cost }
            : {}),
    };
};
const taskKindSchema = {
    type: "object",
    additionalProperties: false,
    required: ["taskKind", "confidence"],
    properties: {
        taskKind: {
            type: "string",
            enum: [
                "repository_task",
                "outside_scope",
                "insufficient_information",
            ],
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
    },
};
const taskKindSystemPrompt = `You are the first-stage runtime gate for a personalized coding router.

Classify the complete visible task-aware context into exactly one task kind:

- repository_task: a concrete repository task can be identified. This includes
  work in a known area and concrete repository work that may introduce a new
  area.
- outside_scope: the request is not repository work.
- insufficient_information: the request does not provide enough visible
  context to identify concrete repository work.

Use the repository profile and all supplied task context. Resolve short or
referential current requests from their task anchor, recent assistant context,
earlier user context, or diagnostic when available. Do not decide which
repository area applies. Return only the structured decision.`;
export const classifyTaskKindWithLuna = async (input) => {
    const messages = [
        { role: "system", content: taskKindSystemPrompt },
        {
            role: "user",
            content: `[TASK-AWARE CONTEXT]\n${input.taskEnvelope}`,
        },
    ];
    const started = performance.now();
    const response = await requestJson(`${API_BASE}/chat/completions`, {
        model: input.model,
        temperature: 0,
        max_tokens: input.maxOutputTokens ?? 64,
        reasoning: { effort: input.reasoningEffort ?? "none" },
        messages,
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "runtime_task_kind",
                strict: true,
                schema: taskKindSchema,
            },
        },
    });
    const content = response.choices[0]?.message.content;
    if (!content)
        throw new Error("Luna task-kind gate returned no content");
    const parsed = JSON.parse(content);
    if (![
        "repository_task",
        "outside_scope",
        "insufficient_information",
    ].includes(parsed.taskKind)) {
        throw new Error(`Luna returned invalid task kind ${parsed.taskKind}`);
    }
    const inputCharacters = messages.reduce((sum, message) => sum + message.content.length, 0);
    return {
        schemaVersion: 1,
        taskEpisodeId: input.taskEpisodeId,
        classifier: input.classifierLabel ?? `llm:${input.model}:task-kind-gate`,
        taskKind: parsed.taskKind,
        confidence: parsed.confidence,
        durationMs: performance.now() - started,
        inputCharacters,
        ...(response.usage?.prompt_tokens !== undefined
            ? { inputTokens: response.usage.prompt_tokens }
            : {}),
        ...(response.usage?.prompt_tokens_details?.cached_tokens !== undefined
            ? {
                cachedInputTokens: response.usage.prompt_tokens_details.cached_tokens,
            }
            : {}),
        ...(response.usage?.completion_tokens !== undefined
            ? { outputTokens: response.usage.completion_tokens }
            : {}),
        ...(response.usage?.completion_tokens_details?.reasoning_tokens !==
            undefined
            ? {
                reasoningOutputTokens: response.usage.completion_tokens_details.reasoning_tokens,
            }
            : {}),
        ...(response.usage?.cost !== undefined
            ? { costUsd: response.usage.cost }
            : {}),
    };
};
