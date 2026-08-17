import { areaOverviewText, referenceTaskText } from "./area-text.js";
import { embedTexts } from "./openrouter.js";
import { serializeTaskEnvelope } from "./serialization.js";
export const buildEmbeddingInputs = (profile, cards, episodes) => {
    const byId = new Map(episodes.map((episode) => [episode.id, episode]));
    return {
        tasks: episodes.filter((episode) => episode.split !== "reference").map((episode) => ({ id: episode.id, text: serializeTaskEnvelope(episode, profile).text })),
        overviews: cards.map((card) => ({ id: `overview:${card.areaId}`, text: areaOverviewText(card) })),
        examples: cards.flatMap((card) => card.positiveExampleIds.map((id) => {
            const episode = byId.get(id);
            if (!episode)
                throw new Error(`Area Card references missing episode: ${id}`);
            return { id: `example:${card.areaId}:${id}`, text: referenceTaskText(episode) };
        })),
    };
};
export const buildRepresentationEmbeddingInputs = (profile, cards, episodes) => {
    const canonical = buildEmbeddingInputs(profile, cards, episodes);
    const evaluation = episodes.filter((episode) => episode.split !== "reference");
    return {
        tasks: evaluation.map((episode) => ({
            id: episode.id,
            representation: "task_aware_repo_profile",
            text: serializeTaskEnvelope(episode, profile).text,
        })),
        overviews: canonical.overviews, examples: canonical.examples,
    };
};
export const embedWithCache = async (model, cache, groups) => {
    const all = groups.flat();
    const vectors = new Map();
    const missing = [];
    for (const input of all) {
        const cached = await cache.get(model, input.id, input.text);
        if (cached)
            vectors.set(input.id, cached);
        else
            missing.push(input);
    }
    let usageTokens;
    for (let start = 0; start < missing.length; start += 32) {
        const batch = missing.slice(start, start + 32);
        const response = await embedTexts(model, batch);
        usageTokens = (usageTokens ?? 0) + (response.usageTokens ?? 0);
        for (const vector of response.vectors) {
            const input = batch.find((item) => item.id === vector.id);
            if (!input)
                throw new Error(`Unexpected embedding vector ${vector.id}`);
            await cache.put(model, input.text, vector);
            vectors.set(vector.id, vector);
        }
    }
    const take = (items) => items.map((item) => { const vector = vectors.get(item.id); if (!vector)
        throw new Error(`Missing vector ${item.id}`); return vector; });
    return { taskVectors: take(groups[0] ?? []), overviewVectors: take(groups[1] ?? []), exampleVectors: take(groups[2] ?? []), hostedInputs: missing.length, cachedInputs: all.length - missing.length, ...(usageTokens !== undefined ? { usageTokens } : {}) };
};
export const embedRepresentationInputs = async (model, cache, inputs) => {
    const groups = [
        inputs.tasks.map(({ id, text, representation }) => ({ id: `${representation}:${id}`, text })),
        inputs.overviews,
        inputs.examples,
    ];
    const embedded = await embedWithCache(model, cache, groups);
    return {
        taskVectors: embedded.taskVectors.map((vector) => {
            const separator = vector.id.indexOf(":");
            const representation = vector.id.slice(0, separator);
            if (representation !== "task_aware_repo_profile")
                throw new Error(`Unexpected representation vector ${vector.id}`);
            return { id: vector.id.slice(separator + 1), values: vector.values, representation };
        }),
        overviewVectors: embedded.overviewVectors, exampleVectors: embedded.exampleVectors,
        hostedInputs: embedded.hostedInputs, cachedInputs: embedded.cachedInputs,
        ...(embedded.usageTokens !== undefined ? { usageTokens: embedded.usageTokens } : {}),
    };
};
