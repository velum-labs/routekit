import { providerDefaultBaseUrl, subscriptionInfo } from "@velum-labs/routekit-registry";
import {
  executeWebRequest,
  RouteKitFailure,
  routeKitError,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { loadSubscriptionCredential } from "../credentials.js";
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
import type {
  ConsumeResetCreditResult,
  SubscriptionProvider,
  SubscriptionStreamOutcome
} from "./shared.js";
import {
  adminRequest,
  authenticationFailure,
  booleanValue,
  CREDENTIAL_ERROR_IDENTIFIERS,
  defineWindow,
  discoverSubscriptionModels,
  epochSeconds,
  errorMessage,
  isRecord,
  MODEL_ERROR_IDENTIFIERS,
  numeric,
  percentageUtilization,
  refreshNetworkFailure,
  refreshResponseBody,
  retryAfter,
  SubscriptionRefreshError,
  usageRequest,
  windowsFromUsagePayload
} from "./shared.js";

function codexErrorRecord(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const response = isRecord(payload.response) ? payload.response : undefined;
  const error = isRecord(payload.error)
    ? payload.error
    : isRecord(response?.error)
      ? response.error
      : undefined;
  return error;
}

function codexFailure(payload: unknown, fallback: string): SubscriptionFailure {
  const error = codexErrorRecord(payload);
  const type =
    typeof error?.type === "string"
      ? error.type
      : typeof error?.error_type === "string"
        ? error.error_type
        : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const identifiers = [type, code]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toLowerCase());
  const identity = identifiers.join(" ");
  const credential = identifiers.some((value) => CREDENTIAL_ERROR_IDENTIFIERS.has(value));
  const memberModel = identifiers.some((value) => MODEL_ERROR_IDENTIFIERS.has(value));
  const quota = /usage[_ ]?limit|usagelimit|quota|insufficient_quota/.test(identity);
  const transient = /rate[_ ]?limit|server_error|temporar|overload|timeout|unavailable/.test(
    identity
  );
  const resetsAt = epochSeconds(error?.resets_at ?? error?.reset_at);
  return {
    category: credential
      ? "auth_permanent"
      : quota
        ? "quota_exhausted"
        : transient
          ? "transient"
          : "unknown",
    ...(credential
      ? { scope: "credential" as const, status: 401 }
      : memberModel
        ? { scope: "member_model" as const }
        : {}),
    message: typeof error?.message === "string" ? error.message : fallback,
    ...(type !== undefined ? { type } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {})
  };
}

function codexStreamOutcome(
  event: string | undefined,
  payload: unknown
): SubscriptionStreamOutcome {
  const record = isRecord(payload) ? payload : undefined;
  const eventType = event ?? (typeof record?.type === "string" ? record.type : undefined);
  if (eventType === "response.completed") return { terminal: "success" };
  if (eventType === "response.failed" || eventType === "error") {
    return {
      terminal: "failure",
      failure: codexFailure(payload, "Codex response failed")
    };
  }
  if (eventType === "response.incomplete") {
    const response = isRecord(record?.response) ? record.response : undefined;
    const details = isRecord(response?.incomplete_details)
      ? response.incomplete_details
      : undefined;
    const reason = typeof details?.reason === "string" ? details.reason : undefined;
    const failure = codexFailure(payload, "Codex response was incomplete");
    return {
      terminal: "failure",
      failure:
        failure.type !== undefined || failure.code !== undefined
          ? failure
          : {
              ...failure,
              category: reason === "server_error" ? "transient" : "unknown",
              ...(reason !== undefined ? { type: reason } : {})
            }
    };
  }
  const semanticOutput =
    eventType === "response.output_text.delta" ||
    eventType === "response.reasoning_summary_text.delta" ||
    eventType === "response.reasoning_text.delta" ||
    eventType === "response.function_call_arguments.delta" ||
    (eventType === "response.output_item.added" &&
      isRecord(record?.item) &&
      record.item.type === "function_call");
  return semanticOutput ? { semanticOutput: true } : {};
}

export function codexProvider(): SubscriptionProvider<"codex"> {
  const mode = "codex" as const;
  const info = subscriptionInfo(mode);
  return {
    mode,
    upstreamBaseUrl: providerDefaultBaseUrl("codex") ?? "https://chatgpt.com/backend-api/codex",
    requestPath: "/responses",
    loadCredential: (path) =>
      Effect.tryPromise({
        try: () => loadSubscriptionCredential(mode, path),
        catch: toRouteKitFailure
      }),
    discoverModels: (credential, signal) =>
      discoverSubscriptionModels(
        mode,
        providerDefaultBaseUrl("codex") ?? "https://chatgpt.com/backend-api/codex",
        {
          authorization: `Bearer ${credential.accessToken}`,
          ...(credential.accountId !== undefined
            ? { "chatgpt-account-id": credential.accountId }
            : {})
        },
        signal
      ),
    authHeaders: (credential) => ({
      authorization: `Bearer ${credential.accessToken}`,
      ...(credential.accountId !== undefined ? { "chatgpt-account-id": credential.accountId } : {}),
      ...(info.defaultHeaders ?? {})
    }),
    refresh: (credential, signal) =>
      Effect.gen(function* () {
        if (credential.refreshToken === undefined) {
          return yield* Effect.fail(
            new SubscriptionRefreshError({
              kind: "permanent",
              reasonCode: "missing_refresh_token"
            })
          );
        }
        const body = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          client_id: info.oauth.clientId
        });
        const response = yield* executeWebRequest(info.oauth.tokenEndpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded"
          },
          body,
          ...(signal !== undefined ? { signal } : {})
        }).pipe(Effect.mapError((error) => refreshNetworkFailure(error)));
        const decoded = yield* Effect.tryPromise({
          try: () => decodeJsonBody(response),
          catch: (cause) => refreshNetworkFailure(cause)
        });
        if (response.ok && !decoded.hasJsonBody) {
          return yield* Effect.fail(
            new SubscriptionRefreshError({
              kind: "transient",
              status: response.status,
              failureKind: "protocol"
            })
          );
        }
        return yield* Effect.tryPromise({
          try: () => refreshResponseBody(response, decoded.body, credential),
          catch: (cause) => refreshNetworkFailure(cause)
        });
      }).pipe(Effect.mapError(refreshNetworkFailure)),
    fetchUsage: (credential, signal) =>
      Effect.gen(function* () {
        const payload = yield* usageRequest(
          info.oauth.usageEndpoint,
          {
            authorization: `Bearer ${credential.accessToken}`,
            ...(credential.accountId !== undefined
              ? { "chatgpt-account-id": credential.accountId }
              : {})
          },
          signal
        );
        return yield* Effect.try({
          try: () => codexUsageLimits(payload),
          catch: toRouteKitFailure
        });
      }),
    fetchResetCredits: (credential, signal) =>
      Effect.gen(function* () {
        const endpoint = info.oauth.resetCreditsEndpoint;
        if (endpoint === undefined) {
          return yield* new RouteKitFailure({
            message: "Codex reset-credits endpoint is not configured"
          });
        }
        const payload = yield* usageRequest(
          endpoint,
          {
            authorization: `Bearer ${credential.accessToken}`,
            ...(credential.accountId !== undefined
              ? { "chatgpt-account-id": credential.accountId }
              : {})
          },
          signal
        );
        return yield* Effect.try({
          try: () => parseResetCreditSnapshot(payload),
          catch: toRouteKitFailure
        });
      }),
    consumeResetCredit: (credential, input, signal) =>
      Effect.gen(function* () {
        const endpoint = info.oauth.resetCreditsEndpoint;
        if (endpoint === undefined) {
          return yield* new RouteKitFailure({
            message: "Codex reset-credits endpoint is not configured"
          });
        }
        if (input.redeemRequestId.trim().length === 0) {
          return yield* new RouteKitFailure({ message: "redeemRequestId is required" });
        }
        const creditId = input.creditId?.trim();
        if (input.creditId !== undefined && (creditId === undefined || creditId.length === 0)) {
          return yield* new RouteKitFailure({ message: "creditId must not be empty" });
        }
        const response = yield* executeWebRequest(`${endpoint}/consume`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${credential.accessToken}`,
            ...(credential.accountId !== undefined
              ? { "chatgpt-account-id": credential.accountId }
              : {})
          },
          body: JSON.stringify({
            redeem_request_id: input.redeemRequestId,
            ...(creditId !== undefined ? { credit_id: creditId } : {})
          }),
          ...(signal !== undefined ? { signal } : {})
        }).pipe(Effect.mapError((error) => routeKitError(error)));
        const body = yield* Effect.tryPromise({
          try: async () => {
            try {
              return await response.json();
            } catch {
              return undefined;
            }
          },
          catch: toRouteKitFailure
        });
        if (!response.ok && body === undefined) {
          return yield* new RouteKitFailure({
            message: `Codex reset-credit consume returned ${response.status}`
          });
        }
        const result = parseConsumeResetResult(body, input.redeemRequestId, response.ok);
        if (!response.ok && !result.ok && result.code === "http_error") {
          return yield* new RouteKitFailure({
            message: `Codex reset-credit consume returned ${response.status}`
          });
        }
        return result;
      }),
    parseLimits: (headers, body) => {
      const fromHeaders = codexLimitsFromHeaders(headers);
      if (fromHeaders !== undefined) return fromHeaders;
      if (isRecord(body) && isRecord(body.rate_limit)) {
        return codexUsageLimits(body, "response", "partial");
      }
      return undefined;
    },
    parseStreamEvent: codexStreamLimits,
    parseStreamOutcome: codexStreamOutcome,
    classify: (status, headers, body) => {
      const authentication = authenticationFailure(status, body, `Codex returned ${status}`);
      if (authentication !== undefined) return authentication;
      if (status !== 429 && status < 500) return undefined;
      const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
      const errorType =
        typeof error?.type === "string"
          ? error.type
          : typeof error?.error_type === "string"
            ? error.error_type
            : undefined;
      const quota = errorType === "usage_limit_reached" || errorType === "usageLimitExceeded";
      const resetsAt = epochSeconds(error?.resets_at);
      const retryAfterSeconds = retryAfter(headers, mode);
      const code = typeof error?.code === "string" ? error.code : undefined;
      return {
        category: quota ? "quota_exhausted" : "transient",
        status,
        message: errorMessage(body, `Codex returned ${status}`),
        ...(errorType !== undefined ? { type: errorType } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(retryAfterSeconds !== undefined ? { retryAfter: retryAfterSeconds } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {})
      };
    },
    fetchAdminUsageCost: (adminKey, range, signal) =>
      Effect.gen(function* () {
        const query = new URLSearchParams({
          start_time: String(Math.floor(range.startTime)),
          bucket_width: "1d",
          limit: "31"
        });
        if (range.endTime !== undefined) query.set("end_time", String(Math.floor(range.endTime)));
        const headers = { authorization: `Bearer ${adminKey}` };
        const [usage, cost] = yield* Effect.all(
          [
            adminRequest(info.admin.usageEndpoint, query, headers, signal),
            adminRequest(info.admin.costEndpoint, query, headers, signal)
          ],
          { concurrency: "unbounded" }
        );
        return { usage, cost };
      })
  };
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

function codexLimitsFromHeaders(headers: Headers): AccountLimits | undefined {
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

function codexUsageLimits(
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

function codexResetCreditsFromUsage(
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

function parseResetCredit(value: unknown): ResetCredit | undefined {
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

function parseResetCreditSnapshot(payload: unknown): ResetCreditSnapshot {
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

function normalizeResetConsumeCode(code: string): string {
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

function parseConsumeResetResult(
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

function rateLimitsObject(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.rate_limits)) return value.rate_limits;
  for (const child of Object.values(value)) {
    const found = rateLimitsObject(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function codexStreamLimits(payload: unknown): AccountLimits | undefined {
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
