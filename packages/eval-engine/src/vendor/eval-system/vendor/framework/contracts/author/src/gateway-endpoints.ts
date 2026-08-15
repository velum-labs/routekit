import { Schema } from "effect";

import { evalModelEndpointsUrlBase } from "../../../../../host-env.ts";

import type { ModelsFetch } from "./gateway-models.ts";

/**
 * Public Gateway per-model endpoint listing; needs no auth. One model is
 * served by many endpoints (21 for `deepseek/deepseek-v4-flash` on 2026-07-29)
 * and they differ in quantization, price, context, and uptime, so which endpoint
 * answered is part of what a bakeoff measured.
 */
const GATEWAY_ENDPOINTS_URL_BASE = "http://127.0.0.1:8080/v1/models";
const HTTP_NOT_FOUND = 404;

// Same nullability rule the catalog schema documents: measured against the live
// endpoints API, present-and-null is ordinary rather than exceptional
// (`max_prompt_tokens`, `latency_last_30m`, and `throughput_last_30m` are null on
// every endpoint of every model sampled), so optional-alone would reject most of
// the payload. Excess keys are ignored, so the API can keep growing.
const EndpointNullableString = Schema.optionalKey(Schema.NullOr(Schema.String));
const EndpointNullableNumber = Schema.optionalKey(Schema.NullOr(Schema.Number));
const EndpointNullableBoolean = Schema.optionalKey(
  Schema.NullOr(Schema.Boolean)
);
const EndpointNullableStrings = Schema.optionalKey(
  Schema.NullOr(Schema.Array(Schema.String))
);

const GatewayEndpointPricingSchema = Schema.Struct({
  audio: EndpointNullableString,
  completion: EndpointNullableString,
  discount: EndpointNullableNumber,
  image: EndpointNullableString,
  input_audio_cache: EndpointNullableString,
  input_cache_read: EndpointNullableString,
  input_cache_write: EndpointNullableString,
  input_cache_write_1h: EndpointNullableString,
  internal_reasoning: EndpointNullableString,
  prompt: EndpointNullableString,
  web_search: EndpointNullableString,
});

const GatewayEndpointSchema = Schema.Struct({
  context_length: EndpointNullableNumber,
  latency_last_30m: EndpointNullableNumber,
  max_completion_tokens: EndpointNullableNumber,
  max_prompt_tokens: EndpointNullableNumber,
  name: EndpointNullableString,
  pricing: Schema.optionalKey(Schema.NullOr(GatewayEndpointPricingSchema)),
  provider_name: Schema.String,
  quantization: EndpointNullableString,
  status: EndpointNullableNumber,
  supported_parameters: EndpointNullableStrings,
  supports_implicit_caching: EndpointNullableBoolean,
  tag: EndpointNullableString,
  throughput_last_30m: EndpointNullableNumber,
  uptime_last_1d: EndpointNullableNumber,
  uptime_last_30m: EndpointNullableNumber,
  uptime_last_5m: EndpointNullableNumber,
});

/**
 * The `/models/{author}/{slug}/endpoints` envelope. `endpoints` is optional and
 * nullable because a model with no reachable endpoint must decode to an empty
 * list rather than throw: "nobody serves this right now" is an answer, and a
 * comparison that fails outright cannot report it.
 *
 * Exported so tests can drive projection from a schema-derived arbitrary instead
 * of a hand-written fixture that would drift from the wire shape.
 */
export const GatewayEndpointsResponseSchema = Schema.Struct({
  data: Schema.Struct({
    endpoints: Schema.optionalKey(
      Schema.NullOr(Schema.Array(GatewayEndpointSchema))
    ),
  }),
});

/** Per-token rate card for one endpoint, as the raw decimal strings the API returns. */
interface GatewayEndpointPricing {
  readonly audio?: string | undefined;
  readonly completion?: string | undefined;
  readonly discount?: number | undefined;
  readonly image?: string | undefined;
  readonly inputAudioCache?: string | undefined;
  readonly inputCacheRead?: string | undefined;
  readonly inputCacheWrite?: string | undefined;
  readonly inputCacheWrite1h?: string | undefined;
  readonly internalReasoning?: string | undefined;
  readonly prompt?: string | undefined;
  readonly webSearch?: string | undefined;
}

/**
 * One provider endpoint serving a model.
 *
 * `status` and `uptimeLast30m` are reported, never applied. A negative `status`
 * or a floored uptime marks a degraded endpoint, and a degraded endpoint still
 * belongs in a comparison the caller asked for: dropping it would answer a
 * different question than the one asked, and would hide the very variance this
 * data exists to expose. Absence stays absence for the same reason the catalog
 * keeps it: an unmeasured uptime is not an uptime of zero.
 */
interface GatewayModelEndpoint {
  readonly contextLength?: number | undefined;
  readonly latencyLast30m?: number | undefined;
  readonly maxCompletionTokens?: number | undefined;
  readonly maxPromptTokens?: number | undefined;
  readonly name: string;
  readonly pricing?: GatewayEndpointPricing | undefined;
  readonly providerName: string;
  readonly quantization?: string | undefined;
  readonly status?: number | undefined;
  readonly supportedParameters?: readonly string[] | undefined;
  readonly supportsImplicitCaching?: boolean | undefined;
  readonly tag?: string | undefined;
  readonly throughputLast30m?: number | undefined;
  readonly uptimeLast1d?: number | undefined;
  readonly uptimeLast30m?: number | undefined;
  readonly uptimeLast5m?: number | undefined;
}

const decodeEndpointsResponse = Schema.decodeUnknownSync(
  GatewayEndpointsResponseSchema
);

type DecodedEndpoint = typeof GatewayEndpointSchema.Type;

const projectEndpointPricing = (
  pricing: DecodedEndpoint["pricing"]
): GatewayEndpointPricing | undefined => {
  const rates = pricing ?? undefined;
  return rates === undefined
    ? undefined
    : {
        audio: rates.audio ?? undefined,
        completion: rates.completion ?? undefined,
        discount: rates.discount ?? undefined,
        image: rates.image ?? undefined,
        inputAudioCache: rates.input_audio_cache ?? undefined,
        inputCacheRead: rates.input_cache_read ?? undefined,
        inputCacheWrite: rates.input_cache_write ?? undefined,
        inputCacheWrite1h: rates.input_cache_write_1h ?? undefined,
        internalReasoning: rates.internal_reasoning ?? undefined,
        prompt: rates.prompt ?? undefined,
        webSearch: rates.web_search ?? undefined,
      };
};

const projectEndpoint = (
  endpoint: DecodedEndpoint
): GatewayModelEndpoint => ({
  contextLength: endpoint.context_length ?? undefined,
  latencyLast30m: endpoint.latency_last_30m ?? undefined,
  maxCompletionTokens: endpoint.max_completion_tokens ?? undefined,
  maxPromptTokens: endpoint.max_prompt_tokens ?? undefined,
  name: endpoint.name ?? endpoint.provider_name,
  pricing: projectEndpointPricing(endpoint.pricing),
  providerName: endpoint.provider_name,
  quantization: endpoint.quantization ?? undefined,
  status: endpoint.status ?? undefined,
  supportedParameters: endpoint.supported_parameters ?? undefined,
  supportsImplicitCaching: endpoint.supports_implicit_caching ?? undefined,
  tag: endpoint.tag ?? undefined,
  throughputLast30m: endpoint.throughput_last_30m ?? undefined,
  uptimeLast1d: endpoint.uptime_last_1d ?? undefined,
  uptimeLast30m: endpoint.uptime_last_30m ?? undefined,
  uptimeLast5m: endpoint.uptime_last_5m ?? undefined,
});

/**
 * Decode and project a raw `/endpoints` payload.
 *
 * Unlike the catalog this decodes the list in one pass: an endpoints response
 * covers a single model, so a malformed entry means the comparison for that
 * model is already wrong and silently returning the survivors would understate
 * how many providers serve it.
 */
const decodeGatewayModelEndpoints = (
  payload: unknown
): readonly GatewayModelEndpoint[] =>
  (decodeEndpointsResponse(payload).data.endpoints ?? []).map(projectEndpoint);

/** Build the endpoints URL for a `author/slug` model id, escaping each path segment. */
const gatewayModelEndpointsUrl = (slug: string): string =>
  `${evalModelEndpointsUrlBase()}/${slug
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}/endpoints`;

/**
 * Fetch and decode the endpoints serving `slug`. `fetchImpl` is injectable for
 * tests; `headers` is accepted for parity with the catalog client, which needs
 * them for the authenticated `/models/user` variant.
 */
export const fetchGatewayModelEndpoints = async (
  slug: string,
  fetchImpl: ModelsFetch = fetch,
  headers?: Readonly<Record<string, string>>
): Promise<readonly GatewayModelEndpoint[]> => {
  const response = await fetchImpl(
    gatewayModelEndpointsUrl(slug),
    headers === undefined ? undefined : { headers }
  );
  if (!response.ok) {
    const hint =
      response.status === HTTP_NOT_FOUND
        ? "; Gateway does not know that model id"
        : "";
    throw new Error(
      `Gateway endpoints request for "${slug}" failed with HTTP ${response.status}${hint}`
    );
  }
  const payload: unknown = await response.json();
  return decodeGatewayModelEndpoints(payload);
};

export {
  GATEWAY_ENDPOINTS_URL_BASE,
  decodeGatewayModelEndpoints,
  gatewayModelEndpointsUrl,
};
export type { GatewayEndpointPricing, GatewayModelEndpoint };
