#!/usr/bin/env node

const endpoint = process.env.ROUTEKIT_GATEWAY_URL ?? process.env.AI_GATEWAY_URL;
if (!endpoint) throw new Error("ROUTEKIT_GATEWAY_URL or AI_GATEWAY_URL is required");
const credentials = process.env.ROUTEKIT_GATEWAY_URL
  ? [{ kind: "routekit-eval-token", token: process.env.ROUTEKIT_EVAL_TOKEN }]
  : [
      { kind: "ai-gateway-key", token: process.env.AI_GATEWAY_API_KEY },
      { kind: "vercel-oidc", token: process.env.VERCEL_OIDC_TOKEN }
    ];
const availableCredentials = credentials.filter(({ token }) => Boolean(token));
if (availableCredentials.length === 0) {
  throw new Error(
    "ROUTEKIT_EVAL_TOKEN, AI_GATEWAY_API_KEY, or VERCEL_OIDC_TOKEN is required"
  );
}

const models =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ["openai/gpt-5.6-luna", "openai/gpt-5.6-sol"];

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function economicCost(payload) {
  const usage = record(payload?.usage);
  const details = record(usage?.cost_details ?? usage?.costDetails);
  return (
    positiveNumber(details?.upstream_inference_cost) ??
    positiveNumber(details?.upstreamInferenceCost) ??
    positiveNumber(usage?.market_cost) ??
    positiveNumber(usage?.marketCost) ??
    positiveNumber(payload?.market_cost) ??
    positiveNumber(payload?.marketCost) ??
    positiveNumber(payload?.cost_usd) ??
    positiveNumber(usage?.cost_usd) ??
    positiveNumber(usage?.cost) ??
    positiveNumber(payload?.cost)
  );
}

function responseContent(payload) {
  const message = payload?.choices?.[0]?.message;
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return undefined;
  return message.content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

const results = [];
for (const model of models) {
  const startedAt = performance.now();
  const body = JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content: "Return the requested strict JSON object without prose."
      },
      { role: "user", content: "Return ok=true." }
    ],
    reasoning_effort: "low",
    max_completion_tokens: 256,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "routekit_gateway_canary",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean", const: true } }
        }
      }
    },
    stream: false
  });
  let response;
  let credentialKind;
  for (const [index, credential] of availableCredentials.entries()) {
    response = await fetch(`${endpoint.replace(/\/$/u, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "content-type": "application/json"
      },
      body,
      signal: AbortSignal.timeout(120_000)
    });
    credentialKind = credential.kind;
    if (
      ![401, 403].includes(response.status) ||
      index === availableCredentials.length - 1
    ) {
      break;
    }
  }
  if (response === undefined) throw new Error(`${model} canary request was not attempted`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${model} canary failed (${response.status}): ${text.slice(0, 1000)}`);
  }
  const payload = JSON.parse(text);
  const content = responseContent(payload);
  let parsed;
  try {
    parsed = content === undefined ? undefined : JSON.parse(content);
  } catch {}
  if (parsed?.ok !== true) throw new Error(`${model} returned an invalid canary contract`);
  results.push({
    requestedModel: model,
    actualModel: payload.model,
    credentialKind,
    latencyMs: Math.round(performance.now() - startedAt),
    contractValid: true,
    promptTokens: payload.usage?.prompt_tokens,
    completionTokens: payload.usage?.completion_tokens,
    economicCostUsd: economicCost(payload),
    byok: payload.usage?.is_byok === true
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      endpointKind: process.env.ROUTEKIT_GATEWAY_URL
        ? "routekit"
        : "vercel-ai-gateway",
      results
    },
    null,
    2
  )
);
