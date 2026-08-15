// Model-slug resolution for the `pi` subprocess.
//
// pi inherits the host environment (including any ambient `AWS_*`/Bedrock
// credentials), so the harness pins routing to Gateway in two ways:
//
//   1. It ALWAYS passes a `--model` flag. Omitting it lets pi fall back to its
//      own compiled-in per-provider default, which — with ambient AWS creds —
//      resolves to a Bedrock model such as `us.anthropic.claude-opus-4-6-v1`.
//      A caller that supplies no model (null/absent/blank) is pinned to the
//      configured default instead (see `resolvePiModel`).
//   2. It forces every slug through the `gateway/` provider segment (see
//      `forceGatewayModelSlug`), so neither a bare slug nor the default can
//      resolve against a non-Gateway provider.
//
// See RFC 0006 (`docs/rfcs/0006-builtins/builtin-pi-harness.md`) rule 4.

import { normalizeEnvValue } from "../../../routekit-eval/src/process.ts";

const EMPTY_LENGTH = 0;

const GATEWAY_MODEL_PREFIX = "gateway/";
const GATEWAY_LATEST_ALIAS_PREFIX = "~";
const ANTHROPIC_MODEL_PREFIX = "anthropic/";

const PI_FALLBACK_DEFAULT_MODEL = "~anthropic/claude-opus-latest";
const ROUTEKIT_EVAL_PI_DEFAULT_MODEL_ENV = "ROUTEKIT_EVAL_PI_DEFAULT_MODEL";

const ROUTEKIT_EVAL_PI_MAX_TOKENS_ENV = "ROUTEKIT_EVAL_PI_MAX_TOKENS";

const RADIX_DECIMAL = 10;

// Gateway's 402 credit/budget rejection ("This request requires more credits,
// or fewer max_tokens. You requested up to N tokens, but can only afford M")
// carries the affordable figure M only in the message string, so it is parsed
// out. See ROUTEKIT_EVAL-351 and https://routekit.dev/docs.
const AFFORDABLE_MAX_TOKENS_PATTERN = /can only afford\s+([\d,]+)/iu;
const REQUESTED_MAX_TOKENS_PATTERN = /requested up to\s+([\d,]+)/iu;
const REMEDIATION_URL_PATTERN = /\bto\s+increase,\s+visit\s+(https?:\/\/\S+)/iu;
const NON_ASCII_PRINTABLE_PATTERN = /[^\u0021-\u007E]/u;
const GATEWAY_HOSTNAME_PATTERN = /(?:^|\.)gateway\.ai$/iu;

const GATEWAY_CREDITS_URL = "the RouteKit gateway account";
const MAX_REMEDIATION_URL_LENGTH = 200;

// A small margin below "afford M" absorbs the prompt-token drift between
// attempts so the retry lands under budget rather than exactly on the line.
const AFFORD_MARGIN_RATIO = 0.9;
const MIN_MAX_TOKENS = 1;

/**
 * Force a model slug to route through the Gateway provider by prepending the
 * `gateway/` provider segment. Callers hand this Gateway catalog ids
 * (`x-ai/grok-4.5`, `gateway/fusion`), so an `gateway/`-leading value is
 * treated as already forced only when the remainder still looks like a catalog
 * id (contains a `/`): `gateway/x-ai/grok-4.5` passes through unchanged,
 * while the first-party catalog id `gateway/fusion` gains the provider
 * segment (`gateway/gateway/fusion`) so pi routes it through Gateway
 * rather than treating `fusion` as the model.
 */
const forceGatewayModelSlug = (model: string): string => {
  if (!model.startsWith(GATEWAY_MODEL_PREFIX)) {
    return `${GATEWAY_MODEL_PREFIX}${model}`;
  }
  const remainder = model.slice(GATEWAY_MODEL_PREFIX.length);
  return remainder.includes("/") ? model : `${GATEWAY_MODEL_PREFIX}${model}`;
};

const readPiDefaultModel = (env: NodeJS.ProcessEnv): string =>
  normalizeEnvValue(env[ROUTEKIT_EVAL_PI_DEFAULT_MODEL_ENV]) ?? PI_FALLBACK_DEFAULT_MODEL;

/**
 * The final `--model` slug for an invocation: the caller's model when it is a
 * non-empty (trimmed) string, otherwise the configured default — always forced
 * through the `gateway/` provider.
 */
const resolvePiModel = (
  requested: string | null | undefined,
  defaultModel: string
): string => {
  const trimmed = typeof requested === "string" ? requested.trim() : "";
  const model = trimmed.length > EMPTY_LENGTH ? trimmed : defaultModel;
  return forceGatewayModelSlug(model);
};

/**
 * The pi-side model id for a forced `gateway/...` slug: pi keys its
 * `providers.gateway.modelOverrides` by the id WITHIN the provider, so the
 * leading `gateway/` segment is dropped (`gateway/deepseek/r1:free` →
 * `deepseek/r1:free`).
 */
const piGatewayModelId = (forcedSlug: string): string =>
  forcedSlug.startsWith(GATEWAY_MODEL_PREFIX)
    ? forcedSlug.slice(GATEWAY_MODEL_PREFIX.length)
    : forcedSlug;

/**
 * Whether a pi model slug resolves to an Anthropic model, in either the forced
 * (`gateway/~anthropic/claude-opus-latest`) or provider-stripped
 * (`~anthropic/claude-opus-latest`) form.
 *
 * The leading `~` is Gateway's "latest model resolution" alias and does not
 * change the underlying vendor, but pi 0.80.2 omits `compat.cacheControlFormat`
 * on every `~anthropic/*` catalog entry AND its fallback prefix test
 * (`model.id.startsWith("anthropic/")`) is defeated by the same `~`, so routekit-eval
 * decides vendor identity itself. See ROUTEKIT_EVAL-950.
 */
const isAnthropicPiModelSlug = (slug: string): boolean => {
  const providerScoped = piGatewayModelId(slug);
  const withoutAlias = providerScoped.startsWith(GATEWAY_LATEST_ALIAS_PREFIX)
    ? providerScoped.slice(GATEWAY_LATEST_ALIAS_PREFIX.length)
    : providerScoped;
  return withoutAlias.startsWith(ANTHROPIC_MODEL_PREFIX);
};

const parsePositiveInt = (value: string | undefined): number | undefined => {
  const normalized = normalizeEnvValue(value);
  if (normalized === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(normalized, RADIX_DECIMAL);
  return Number.isFinite(parsed) && parsed > EMPTY_LENGTH ? parsed : undefined;
};

/** The max_tokens cap routekit-eval writes into pi's models.json for the invoked model. */
interface PiMaxTokensCap {
  readonly modelId: string;
  readonly maxTokens: number;
}

/**
 * Resolve the OPTIONAL up-front max_tokens cap for a resolved (forced
 * `gateway/...`) model, or `undefined` when none is configured. Driven only by
 * `ROUTEKIT_EVAL_PI_MAX_TOKENS`; without it, the harness applies no up-front cap and clamps
 * reactively on a 402 instead.
 */
const resolvePiMaxTokensCap = (
  resolvedModel: string,
  env: NodeJS.ProcessEnv
): PiMaxTokensCap | undefined => {
  const envCap = parsePositiveInt(env[ROUTEKIT_EVAL_PI_MAX_TOKENS_ENV]);
  return envCap === undefined
    ? undefined
    : {
        modelId: piGatewayModelId(resolvedModel),
        maxTokens: envCap,
      };
};

/**
 * Parse the affordable-tokens figure from an Gateway 402 error message ("...
 * but can only afford 8515"), or `undefined` when the message is not that error.
 * The figure lives only in the human-readable string; there is no structured
 * field.
 */
const parseTokenFigure = (
  pattern: RegExp,
  errorMessage: string
): number | undefined => {
  const match = pattern.exec(errorMessage);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(match[1].replaceAll(",", ""), RADIX_DECIMAL);
  return Number.isFinite(parsed) && parsed > EMPTY_LENGTH ? parsed : undefined;
};

const parseAffordableMaxTokens = (errorMessage: string): number | undefined =>
  parseTokenFigure(AFFORDABLE_MAX_TOKENS_PATTERN, errorMessage);

const parseRemediationUrl = (errorMessage: string): string | undefined => {
  const match = REMEDIATION_URL_PATTERN.exec(errorMessage);
  const candidate = match?.[1]?.replace(/[.,;:!?)]{1,}$/u, "");
  if (candidate === undefined) {
    return undefined;
  }

  if (
    candidate.length > MAX_REMEDIATION_URL_LENGTH ||
    NON_ASCII_PRINTABLE_PATTERN.test(candidate)
  ) {
    return undefined;
  }
  if (!URL.canParse(candidate)) {
    return undefined;
  }
  const url = new URL(candidate);
  return (url.protocol === "http:" || url.protocol === "https:") &&
    GATEWAY_HOSTNAME_PATTERN.test(url.hostname) &&
    url.username.length === EMPTY_LENGTH &&
    url.password.length === EMPTY_LENGTH &&
    url.href.length <= MAX_REMEDIATION_URL_LENGTH
    ? url.href
    : undefined;
};

/**
 * A plain one-line rendering of an Gateway 402 credit rejection, or
 * `undefined` when the message is not one. The raw 402 body is journalled and
 * streamed to JSONL consumers, so ROUTEKIT_EVAL-882 still forbids echoing it; the only
 * field lifted from it is one routekit.dev URL that is http(s), userinfo-free,
 * ASCII-printable, length-capped, and re-serialized through the URL parser.
 */
const describeCreditShortfall = (errorMessage: string): string | undefined => {
  const afford = parseAffordableMaxTokens(errorMessage);
  if (afford === undefined) {
    return undefined;
  }
  const requested = parseTokenFigure(
    REQUESTED_MAX_TOKENS_PATTERN,
    errorMessage
  );
  const need =
    requested === undefined ? "" : ` this turn needs up to ${requested} and`;
  const remediationUrl =
    parseRemediationUrl(errorMessage) ?? GATEWAY_CREDITS_URL;
  return `Insufficient Gateway credits:${need} the balance affords only ${afford} output tokens. routekit-eval retried with a lower max_tokens and still could not fit. Raise the limit at ${remediationUrl}, or cap the request with ${ROUTEKIT_EVAL_PI_MAX_TOKENS_ENV}.`;
};

/**
 * The max_tokens to request on a clamped retry: the affordable figure trimmed by
 * a small margin so the retry lands under budget rather than exactly on it.
 */
const clampMaxTokensToAfford = (afford: number): number =>
  Math.max(MIN_MAX_TOKENS, Math.floor(afford * AFFORD_MARGIN_RATIO));

export {
  ROUTEKIT_EVAL_PI_DEFAULT_MODEL_ENV,
  ROUTEKIT_EVAL_PI_MAX_TOKENS_ENV,
  PI_FALLBACK_DEFAULT_MODEL,
  clampMaxTokensToAfford,
  describeCreditShortfall,
  forceGatewayModelSlug,
  isAnthropicPiModelSlug,
  parseAffordableMaxTokens,
  piGatewayModelId,
  readPiDefaultModel,
  resolvePiMaxTokensCap,
  resolvePiModel,
};
export type { PiMaxTokensCap };
