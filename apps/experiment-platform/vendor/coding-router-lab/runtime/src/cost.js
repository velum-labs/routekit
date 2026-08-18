export const fetchModelPrices = async () => {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (!response.ok)
        throw new Error(`OpenRouter catalog HTTP ${response.status}`);
    const payload = await response.json();
    return new Map(payload.data.map((model) => [model.id, {
            id: model.id,
            promptUsdPerToken: Number(model.pricing?.prompt ?? Number.NaN),
            completionUsdPerToken: Number(model.pricing?.completion ?? Number.NaN),
            contextLength: model.context_length ?? 0,
        }]));
};
export const fetchEmbeddingModelPrices = async () => {
    const response = await fetch("https://openrouter.ai/api/v1/models?output_modalities=embeddings");
    if (!response.ok)
        throw new Error(`OpenRouter embedding catalog HTTP ${response.status}`);
    const payload = await response.json();
    return new Map(payload.data.map((model) => [model.id, {
            id: model.id,
            promptUsdPerToken: Number(model.pricing?.prompt ?? Number.NaN),
            completionUsdPerToken: 0,
            contextLength: model.context_length ?? 0,
        }]));
};
export const maximumCallCost = (price, inputTokens, outputTokens) => {
    if (![price.promptUsdPerToken, price.completionUsdPerToken, inputTokens, outputTokens].every(Number.isFinite))
        throw new Error("Missing price or token estimate");
    return price.promptUsdPerToken * inputTokens + price.completionUsdPerToken * outputTokens;
};
export const estimateTokens = (text) => Math.ceil(text.length / 3.5);
