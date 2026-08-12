import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRetryAfterSeconds } from "@velum-labs/routekit-contracts";
import {
  decodeModelDiscovery,
  type DiscoveredProviderModel
} from "@velum-labs/routekit-contracts/provider-discovery";
import {
  providerDefaultBaseUrl,
  type SubscriptionMode,
  subscriptionInfo
} from "@velum-labs/routekit-registry";
import { trimSurroundingSlashes, trimTrailingSlashes } from "@velum-labs/routekit-runtime";

import { loadSubscriptionCredential, persistSubscriptionCredential } from "../credentials.js";
import { decodeJsonBody } from "../subscription-http.js";
import type {
  AccountLimits,
  CreditSnapshot,
  RateLimitDiagnostic,
  RateLimitWindow,
  ResetCredit,
  ResetCreditSnapshot,
  SubscriptionCredential,
  SubscriptionFailure
} from "../types.js";

export type AdminUsageRange = {
  startTime: number;
  endTime?: number;
};

export type AdminUsageCost = {
  usage: unknown;
  cost: unknown;
};

export type ConsumeResetCreditInput = {
  creditId?: string;
  redeemRequestId: string;
};

export type ConsumeResetCreditResult = {
  ok: boolean;
  code: string;
  redeemRequestId: string;
  creditId?: string;
  windowsReset?: number;
};

export type SubscriptionStreamOutcome = {
  terminal?: "success" | "failure";
  /** True only for text/reasoning/tool-call semantic output. */
  semanticOutput?: boolean;
  failure?: SubscriptionFailure;
};

export type SubscriptionRefreshFailure =
  | {
      kind: "permanent";
      status?: number;
      reasonCode: "missing_refresh_token" | "invalid_grant" | "invalid_token" | "revoked_token";
    }
  | {
      kind: "transient";
      status?: number;
      retryAfter?: number;
      failureKind: "network" | "rate_limited" | "provider" | "protocol";
    };

export class SubscriptionRefreshError extends Error {
  readonly failure: SubscriptionRefreshFailure;

  constructor(failure: SubscriptionRefreshFailure) {
    super(
      failure.kind === "permanent"
        ? `OAuth refresh permanently failed (${failure.reasonCode})`
        : `OAuth refresh temporarily failed (${failure.failureKind})`
    );
    this.name = "SubscriptionRefreshError";
    this.failure = failure;
  }
}

export class SubscriptionProviderRequestError extends Error {
  readonly failure: SubscriptionFailure;

  constructor(failure: SubscriptionFailure) {
    super(failure.message);
    this.name = "SubscriptionProviderRequestError";
    this.failure = failure;
  }
}

export type SubscriptionProvider<M extends SubscriptionMode = SubscriptionMode> = {
  readonly mode: M;
  readonly upstreamBaseUrl: string;
  readonly requestPath: string;
  loadCredential(path: string): Promise<SubscriptionCredential>;
  discoverModels(
    credential: SubscriptionCredential,
    signal?: AbortSignal
  ): Promise<readonly DiscoveredProviderModel[]>;
  authHeaders(credential: SubscriptionCredential): Record<string, string>;
  refresh(
    credential: SubscriptionCredential,
    signal?: AbortSignal
  ): Promise<SubscriptionCredential>;
  fetchUsage(credential: SubscriptionCredential, signal?: AbortSignal): Promise<AccountLimits>;
  /** List banked rate-limit reset coupons when the provider supports them (Codex). */
  fetchResetCredits?(
    credential: SubscriptionCredential,
    signal?: AbortSignal
  ): Promise<ResetCreditSnapshot>;
  /** Redeem one banked reset coupon. Idempotent via `redeemRequestId`. */
  consumeResetCredit?(
    credential: SubscriptionCredential,
    input: ConsumeResetCreditInput,
    signal?: AbortSignal
  ): Promise<ConsumeResetCreditResult>;
  parseLimits(headers: Headers, body?: unknown): AccountLimits | undefined;
  parseStreamEvent(payload: unknown): AccountLimits | undefined;
  parseStreamOutcome?(event: string | undefined, payload: unknown): SubscriptionStreamOutcome;
  classify(status: number, headers: Headers, body: unknown): SubscriptionFailure | undefined;
  fetchAdminUsageCost(
    adminKey: string,
    range: AdminUsageRange,
    signal?: AbortSignal
  ): Promise<AdminUsageCost>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

export function epochSeconds(value: unknown): number | undefined {
  const direct = numeric(value);
  if (direct !== undefined) return direct;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : undefined;
}

export function utilization(value: unknown): number | undefined {
  const parsed = numeric(value);
  if (parsed === undefined || parsed < 0 || parsed > 1) return undefined;
  return parsed;
}

export function percentageUtilization(value: unknown): number | undefined {
  const parsed = numeric(value);
  if (parsed === undefined || parsed < 0 || parsed > 100) return undefined;
  return parsed / 100;
}

function defineWindow(
  windows: Record<string, RateLimitWindow>,
  key: string,
  window: RateLimitWindow
): void {
  Object.defineProperty(windows, key, {
    value: window,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

/**
 * Canonical identity for a provider quota window, independent of whether it
 * was observed through response headers, a stream event, or a usage endpoint.
 */
export function canonicalRateLimitWindowKey(mode: SubscriptionMode, key: string): string {
  if (mode !== "claude-code") return key;
  const normalized = key.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "5h") return "five_hour";
  if (normalized.startsWith("5h_")) return `five_hour_${normalized.slice(3)}`;
  if (normalized === "7d") return "seven_day";
  if (normalized.startsWith("7d_")) return `seven_day_${normalized.slice(3)}`;
  return normalized;
}

export function retryAfter(headers: Headers, mode: SubscriptionMode): number | undefined {
  return parseRetryAfterSeconds(headers.get(subscriptionInfo(mode).rateLimit.retryAfterHeader));
}

export function errorMessage(body: unknown, fallback: string): string {
  if (!isRecord(body)) return fallback;
  const error = body.error;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (typeof body.message === "string") return body.message;
  return fallback;
}

export const CREDENTIAL_ERROR_IDENTIFIERS = new Set([
  "authentication_error",
  "invalid_token",
  "invalidated_token",
  "oauth_token_invalid",
  "token_revoked",
  "revoked_token",
  "unauthorized"
]);

export const MODEL_ERROR_IDENTIFIERS = new Set([
  "model_not_found",
  "model_not_allowed",
  "model_access_denied",
  "unsupported_model"
]);

export function structuredError(body: unknown): {
  message?: string;
  type?: string;
  code?: string;
} {
  const outer = isRecord(body) ? body : undefined;
  const response = isRecord(outer?.response) ? outer.response : undefined;
  const error = isRecord(outer?.error)
    ? outer.error
    : isRecord(response?.error)
      ? response.error
      : undefined;
  const type =
    typeof error?.type === "string"
      ? error.type
      : typeof error?.error_type === "string"
        ? error.error_type
        : undefined;
  return {
    ...(typeof error?.message === "string" ? { message: error.message } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(typeof error?.code === "string" ? { code: error.code } : {})
  };
}

export function authenticationFailure(
  status: number,
  body: unknown,
  fallback: string
): SubscriptionFailure | undefined {
  if (status !== 401 && status !== 403) return undefined;
  const error = structuredError(body);
  const identifiers = [error.type, error.code]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toLowerCase());
  const scope =
    status === 401
      ? "credential"
      : identifiers.some((value) => CREDENTIAL_ERROR_IDENTIFIERS.has(value))
        ? "credential"
        : identifiers.some((value) => MODEL_ERROR_IDENTIFIERS.has(value))
          ? "member_model"
          : "request";
  return {
    category: scope === "credential" ? "auth_permanent" : "unknown",
    scope,
    status,
    message: error.message ?? fallback,
    ...(error.type !== undefined ? { type: error.type } : {}),
    ...(error.code !== undefined ? { code: error.code } : {})
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlashes(baseUrl)}/${trimSurroundingSlashes(path)}`;
}

function expandedPath(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function readCodexModelsCache(): unknown | undefined {
  const path = subscriptionInfo("codex").modelsCachePath;
  if (path === undefined || !existsSync(expandedPath(path))) return undefined;
  try {
    return JSON.parse(readFileSync(expandedPath(path), "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function cachedCodexClientVersion(): string | undefined {
  const cache = readCodexModelsCache();
  return isRecord(cache) && typeof cache.client_version === "string"
    ? cache.client_version
    : undefined;
}

export function codexModelsSearch(
  search: string,
  clientVersion: string | undefined = cachedCodexClientVersion() ??
    subscriptionInfo("codex").discovery.clientVersion
): string {
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (query.has("client_version") || clientVersion === undefined) return search;
  const separator = search.length === 0 ? "?" : search.includes("?") ? "&" : "?";
  return `${search}${separator}client_version=${encodeURIComponent(clientVersion)}`;
}

export async function discoverSubscriptionModels(
  mode: SubscriptionMode,
  baseUrl: string,
  authHeaders: Record<string, string>,
  signal?: AbortSignal
): Promise<readonly DiscoveredProviderModel[]> {
  const info = subscriptionInfo(mode);
  const codexClientVersion =
    mode === "codex" ? (cachedCodexClientVersion() ?? info.discovery.clientVersion) : undefined;
  const discoveryPath =
    mode === "codex"
      ? `${info.discovery.path}${codexModelsSearch("", codexClientVersion)}`
      : info.discovery.path;
  try {
    const response = await fetch(joinUrl(baseUrl, discoveryPath), {
      headers: {
        accept: "application/json",
        ...(info.discovery.extraHeaders ?? {}),
        ...authHeaders
      },
      ...(signal !== undefined ? { signal } : {})
    });
    const { body, hasJsonBody } = await decodeJsonBody(response);
    if (!response.ok) {
      throw new SubscriptionProviderRequestError(
        authenticationFailure(
          response.status,
          body,
          `model discovery returned HTTP ${response.status}`
        ) ?? {
          category: response.status >= 500 ? "transient" : "unknown",
          status: response.status,
          message: `model discovery returned HTTP ${response.status}`
        }
      );
    }
    if (!hasJsonBody) {
      throw new SubscriptionProviderRequestError({
        category: "unknown",
        status: response.status,
        message: "model discovery returned malformed JSON"
      });
    }
    return decodeModelDiscovery(info.discovery.responseShape, body, { provider: mode });
  } catch (error) {
    if (
      mode !== "codex" ||
      info.discovery.cacheFallback !== true ||
      (error instanceof SubscriptionProviderRequestError && error.failure.scope === "credential")
    ) {
      throw error;
    }
    const cached = readCodexModelsCache();
    if (cached === undefined) throw error;
    const cachedModels = decodeModelDiscovery(info.discovery.responseShape, cached, {
      provider: mode
    }).filter((model) => !model.id.includes("/"));
    return [
      { id: info.defaultModel },
      ...cachedModels.filter((model) => model.id !== info.defaultModel)
    ];
  }
}

export function refreshPayload(body: unknown): {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
} {
  if (!isRecord(body) || typeof body.access_token !== "string") {
    throw new SubscriptionRefreshError({
      kind: "transient",
      failureKind: "protocol"
    });
  }
  const expiresIn = numeric(body.expires_in);
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(expiresIn !== undefined ? { expiresAt: Date.now() / 1000 + expiresIn } : {})
  };
}

export function refreshReasonCode(
  body: unknown
): Extract<SubscriptionRefreshFailure, { kind: "permanent" }>["reasonCode"] | undefined {
  const error = structuredError(body);
  const code = (error.code ?? error.type)?.toLowerCase();
  if (code === "invalid_grant") return "invalid_grant";
  if (code === "invalid_token") return "invalid_token";
  if (
    code === "revoked_token" ||
    code === "token_revoked" ||
    code === "invalidated_token" ||
    code === "oauth_token_invalid"
  ) {
    return "revoked_token";
  }
  return undefined;
}

export function refreshResponseBody(
  response: Response,
  body: unknown,
  credential: SubscriptionCredential
): Promise<SubscriptionCredential> {
  if (!response.ok) {
    const reasonCode = refreshReasonCode(body);
    if (response.status === 401 || response.status === 403 || reasonCode !== undefined) {
      throw new SubscriptionRefreshError({
        kind: "permanent",
        status: response.status,
        reasonCode: reasonCode ?? "invalid_token"
      });
    }
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
    const rateLimited =
      response.status === 408 || response.status === 425 || response.status === 429;
    throw new SubscriptionRefreshError({
      kind: "transient",
      status: response.status,
      failureKind: rateLimited ? "rate_limited" : response.status >= 500 ? "provider" : "protocol",
      ...(retryAfterSeconds !== undefined ? { retryAfter: retryAfterSeconds } : {})
    });
  }
  return persistSubscriptionCredential(credential, refreshPayload(body));
}

export function refreshNetworkError(error: unknown): never {
  if (error instanceof SubscriptionRefreshError) throw error;
  throw new SubscriptionRefreshError({
    kind: "transient",
    failureKind: "network"
  });
}

export function windowsFromUsagePayload(
  mode: SubscriptionMode,
  payload: unknown,
  observedAt: number,
  source: AccountLimits["source"]
): {
  windows: Record<string, RateLimitWindow>;
  diagnostics: RateLimitDiagnostic[];
} {
  if (!isRecord(payload)) return { windows: {}, diagnostics: [] };
  const windows = Object.create(null) as Record<string, RateLimitWindow>;
  const diagnostics: RateLimitDiagnostic[] = [];
  for (const [key, raw] of Object.entries(payload)) {
    if (!isRecord(raw)) continue;
    const window = canonicalRateLimitWindowKey(mode, key);
    const field =
      raw.utilization === undefined || raw.utilization === null ? "used_percent" : "utilization";
    const value = raw[field];
    // The Claude OAuth usage endpoint reports `utilization` as a percentage
    // (for example, 97 for 97%), unlike Anthropic's response headers, which
    // use a normalized fraction. Codex uses `used_percent` in this payload
    // family, so both of these fields are percentages here.
    const used =
      field === "used_percent" || mode === "claude-code"
        ? percentageUtilization(value)
        : utilization(value);
    if (used === undefined) {
      if (value !== undefined && value !== null) {
        diagnostics.push({ code: "invalid_utilization", window, field });
      }
      continue;
    }
    const resetsAt = epochSeconds(raw.resets_at ?? raw.reset_at);
    const windowSeconds = numeric(raw.limit_window_seconds);
    defineWindow(windows, window, {
      utilization: used,
      ...(typeof raw.status === "string" ? { status: raw.status } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(windowSeconds !== undefined ? { windowSeconds } : {}),
      observedAt,
      source
    });
  }
  return { windows, diagnostics };
}

export function anthropicLimitsFromHeaders(headers: Headers): AccountLimits | undefined {
  const prefix = subscriptionInfo("claude-code").rateLimit.headerPrefix.toLowerCase();
  const observedAt = Date.now() / 1000;
  const windows = Object.create(null) as Record<string, RateLimitWindow>;
  const diagnostics: RateLimitDiagnostic[] = [];
  const suffixes = new Set<string>();
  for (const [name] of headers) {
    const lowered = name.toLowerCase();
    const match = new RegExp(`^${prefix}-(.+)-(utilization|status|reset)$`).exec(lowered);
    if (match?.[1] !== undefined) suffixes.add(match[1]);
  }
  for (const key of suffixes) {
    const window = canonicalRateLimitWindowKey("claude-code", key);
    const raw = headers.get(`${prefix}-${key}-utilization`);
    const used = utilization(raw);
    if (used === undefined) {
      if (raw !== null) {
        diagnostics.push({
          code: "invalid_utilization",
          window,
          field: "utilization"
        });
      }
      continue;
    }
    const status = headers.get(`${prefix}-${key}-status`);
    const resetsAt = epochSeconds(headers.get(`${prefix}-${key}-reset`));
    defineWindow(windows, window, {
      utilization: used,
      ...(status !== null ? { status } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      observedAt,
      source: "headers"
    });
  }
  return Object.keys(windows).length > 0 || diagnostics.length > 0
    ? {
        windows,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
        observedAt,
        source: "headers",
        completeness: "partial"
      }
    : undefined;
}

function codexWindowFromHeaders(
  headers: Headers,
  prefix: string,
  name: string,
  window: string,
  observedAt: number
): { window?: RateLimitWindow; diagnostic?: RateLimitDiagnostic } {
  const raw = headers.get(`${prefix}-${name}-used-percent`);
  const used = percentageUtilization(raw);
  if (used === undefined) {
    return raw === null
      ? {}
      : {
          diagnostic: {
            code: "invalid_utilization",
            window,
            field: "used_percent"
          }
        };
  }
  const minutes = numeric(headers.get(`${prefix}-${name}-window-minutes`));
  const resetsAt = epochSeconds(headers.get(`${prefix}-${name}-reset-at`));
  const limitName = headers.get(`${prefix}-limit-name`);
  return {
    window: {
      utilization: used,
      ...(minutes !== undefined ? { windowSeconds: minutes * 60 } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(limitName !== null ? { limitName } : {}),
      observedAt,
      source: "headers"
    }
  };
}

function codexCredits(headers: Headers): CreditSnapshot | undefined {
  const hasCredits = booleanValue(headers.get("x-codex-credits-has-credits"));
  const unlimited = booleanValue(headers.get("x-codex-credits-unlimited"));
  const balance = headers.get("x-codex-credits-balance");
  if (hasCredits === undefined && unlimited === undefined && balance === null) return undefined;
  return {
    ...(hasCredits !== undefined ? { hasCredits } : {}),
    ...(unlimited !== undefined ? { unlimited } : {}),
    ...(balance !== null ? { balance } : {})
  };
}

export function codexLimitsFromHeaders(headers: Headers): AccountLimits | undefined {
  const info = subscriptionInfo("codex").rateLimit;
  const observedAt = Date.now() / 1000;
  const defaultPrefix = info.headerPrefix.toLowerCase();
  const prefixes = new Set<string>();
  for (const [name] of headers) {
    const match = /^(.+)-(?:primary|secondary)-used-percent$/.exec(name.toLowerCase());
    if (match?.[1]?.startsWith("x-") === true) prefixes.add(match[1]);
  }
  const windows = Object.create(null) as Record<string, RateLimitWindow>;
  const diagnostics: RateLimitDiagnostic[] = [];
  for (const prefix of [...prefixes].sort((left, right) => {
    if (left === defaultPrefix) return -1;
    if (right === defaultPrefix) return 1;
    return left.localeCompare(right);
  })) {
    const family = prefix === defaultPrefix ? "codex" : prefix.slice(2).replaceAll("-", "_");
    for (const name of ["primary", "secondary"] as const) {
      const key = `${family}:${name}`;
      const parsed = codexWindowFromHeaders(headers, prefix, name, key, observedAt);
      if (parsed.window !== undefined) defineWindow(windows, key, parsed.window);
      if (parsed.diagnostic !== undefined) diagnostics.push(parsed.diagnostic);
    }
  }
  const credits = codexCredits(headers);
  if (Object.keys(windows).length === 0 && diagnostics.length === 0 && credits === undefined) {
    return undefined;
  }
  return {
    windows,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(credits !== undefined ? { credits } : {}),
    observedAt,
    source: "headers",
    completeness: "partial"
  };
}

export function codexUsageLimits(
  payload: unknown,
  source: AccountLimits["source"] = "usage",
  completeness: AccountLimits["completeness"] = "snapshot"
): AccountLimits {
  if (!isRecord(payload)) throw new Error("Codex usage endpoint returned an invalid payload");
  const observedAt = Date.now() / 1000;
  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : {};
  const parsed = windowsFromUsagePayload(
    "codex",
    {
      primary: rateLimit.primary_window,
      secondary: rateLimit.secondary_window
    },
    observedAt,
    source
  );
  const rawCredits = isRecord(payload.credits) ? payload.credits : undefined;
  const credits =
    rawCredits === undefined
      ? undefined
      : {
          ...(booleanValue(rawCredits.has_credits) !== undefined
            ? { hasCredits: booleanValue(rawCredits.has_credits) }
            : {}),
          ...(booleanValue(rawCredits.unlimited) !== undefined
            ? { unlimited: booleanValue(rawCredits.unlimited) }
            : {}),
          ...(typeof rawCredits.balance === "string" ? { balance: rawCredits.balance } : {})
        };
  const resetCredits = codexResetCreditsFromUsage(payload, observedAt);
  return {
    windows: parsed.windows,
    ...(parsed.diagnostics.length > 0 ? { diagnostics: parsed.diagnostics } : {}),
    ...(typeof payload.plan_type === "string" ? { planType: payload.plan_type } : {}),
    ...(credits !== undefined ? { credits } : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {}),
    observedAt,
    source,
    completeness
  };
}

export function codexResetCreditsFromUsage(
  payload: Record<string, unknown>,
  observedAt: number
): ResetCreditSnapshot | undefined {
  const raw = isRecord(payload.rate_limit_reset_credits)
    ? payload.rate_limit_reset_credits
    : isRecord(payload.rateLimitResetCredits)
      ? payload.rateLimitResetCredits
      : undefined;
  if (raw === undefined) return undefined;
  const count =
    numeric(raw.available_count) ??
    numeric(raw.availableCount) ??
    (Array.isArray(raw.credits) ? raw.credits.length : undefined);
  if (count === undefined) return undefined;
  const credits = Array.isArray(raw.credits)
    ? raw.credits
        .map((entry) => parseResetCredit(entry))
        .filter((entry): entry is ResetCredit => entry !== undefined)
    : undefined;
  return {
    observedAt,
    availableCount: Math.max(0, Math.floor(count)),
    ...(credits !== undefined && credits.length > 0 ? { credits } : {})
  };
}

export function parseResetCredit(value: unknown): ResetCredit | undefined {
  if (!isRecord(value)) return undefined;
  const id =
    typeof value.id === "string" && value.id.length > 0
      ? value.id
      : typeof value.credit_id === "string" && value.credit_id.length > 0
        ? value.credit_id
        : typeof value.creditId === "string" && value.creditId.length > 0
          ? value.creditId
          : undefined;
  if (id === undefined) return undefined;
  const status = typeof value.status === "string" ? value.status : undefined;
  return {
    id,
    ...(typeof value.reset_type === "string"
      ? { resetType: value.reset_type }
      : typeof value.resetType === "string"
        ? { resetType: value.resetType }
        : {}),
    ...(status !== undefined ? { status } : {}),
    ...(epochSeconds(value.granted_at ?? value.grantedAt) !== undefined
      ? { grantedAt: epochSeconds(value.granted_at ?? value.grantedAt) }
      : {}),
    ...(epochSeconds(value.expires_at ?? value.expiresAt) !== undefined
      ? { expiresAt: epochSeconds(value.expires_at ?? value.expiresAt) }
      : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {})
  };
}

export function parseResetCreditSnapshot(payload: unknown): ResetCreditSnapshot {
  const observedAt = Date.now() / 1000;
  if (!isRecord(payload))
    throw new Error("Codex reset-credits endpoint returned an invalid payload");
  const rows = Array.isArray(payload.credits)
    ? payload.credits
    : Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.data)
        ? payload.data
        : [];
  const credits = rows
    .map((entry) => parseResetCredit(entry))
    .filter((entry): entry is ResetCredit => entry !== undefined);
  const available = credits.filter((credit) => {
    const status = credit.status?.toLowerCase();
    return status === undefined || status === "available" || status === "active";
  });
  const count =
    numeric(payload.available_count) ?? numeric(payload.availableCount) ?? available.length;
  return {
    observedAt,
    availableCount: Math.max(0, Math.floor(count)),
    ...(credits.length > 0 ? { credits } : {})
  };
}

export function normalizeResetConsumeCode(code: string): string {
  switch (code) {
    case "alreadyRedeemed":
      return "already_redeemed";
    case "noCredit":
      return "no_credit";
    case "nothingToReset":
      return "nothing_to_reset";
    default:
      return code;
  }
}

export function parseConsumeResetResult(
  payload: unknown,
  redeemRequestId: string,
  httpOk: boolean
): ConsumeResetCreditResult {
  const body = isRecord(payload) ? payload : undefined;
  const rawCode = typeof body?.code === "string" ? body.code : httpOk ? "reset" : "http_error";
  const code = normalizeResetConsumeCode(rawCode);
  const credit = parseResetCredit(body?.credit ?? body?.rate_limit_reset_credit);
  const windowsReset = numeric(body?.windows_reset ?? body?.windowsReset);
  return {
    ok: code === "reset",
    code,
    redeemRequestId,
    ...(credit?.id !== undefined
      ? { creditId: credit.id }
      : typeof body?.credit_id === "string"
        ? { creditId: body.credit_id }
        : typeof body?.creditId === "string"
          ? { creditId: body.creditId }
          : {}),
    ...(windowsReset !== undefined ? { windowsReset } : {})
  };
}

export function rateLimitsObject(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.rate_limits)) return value.rate_limits;
  for (const child of Object.values(value)) {
    const found = rateLimitsObject(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function codexStreamLimits(payload: unknown): AccountLimits | undefined {
  const raw = rateLimitsObject(payload);
  if (raw === undefined) return undefined;
  const observedAt = Date.now() / 1000;
  const parsed = windowsFromUsagePayload("codex", raw, observedAt, "stream");
  return Object.keys(parsed.windows).length > 0 || parsed.diagnostics.length > 0
    ? {
        windows: parsed.windows,
        ...(parsed.diagnostics.length > 0 ? { diagnostics: parsed.diagnostics } : {}),
        observedAt,
        source: "stream",
        completeness: "partial"
      }
    : undefined;
}

export async function usageRequest(
  endpoint: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetch(endpoint, {
    headers: { accept: "application/json", ...headers },
    ...(signal !== undefined ? { signal } : {})
  });
  const { body, hasJsonBody } = await decodeJsonBody(response);
  if (!response.ok) {
    throw new SubscriptionProviderRequestError(
      authenticationFailure(
        response.status,
        body,
        `subscription usage endpoint returned ${response.status}`
      ) ?? {
        category: response.status >= 500 ? "transient" : "unknown",
        status: response.status,
        message: `subscription usage endpoint returned ${response.status}`
      }
    );
  }
  if (!hasJsonBody) {
    throw new SubscriptionProviderRequestError({
      category: "unknown",
      status: response.status,
      message: "subscription usage endpoint returned malformed JSON"
    });
  }
  return body;
}

export async function adminRequest(
  endpoint: string,
  query: URLSearchParams,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetch(`${endpoint}?${query.toString()}`, {
    headers: { accept: "application/json", ...headers },
    ...(signal !== undefined ? { signal } : {})
  });
  const { body, hasJsonBody } = await decodeJsonBody(response);
  if (!response.ok) throw new Error(`Admin usage endpoint returned ${response.status}`);
  if (!hasJsonBody) throw new Error("Admin usage endpoint returned malformed JSON");
  return body;
}

