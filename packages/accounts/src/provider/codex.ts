import { providerDefaultBaseUrl, subscriptionInfo } from "@velum-labs/routekit-registry";
import { loadSubscriptionCredential } from "../credentials.js";
import { decodeJsonBody } from "../subscription-http.js";
import type { SubscriptionCredential, SubscriptionFailure } from "../types.js";
import {
  SubscriptionRefreshError, SubscriptionProviderRequestError,
  authenticationFailure, errorMessage, epochSeconds, isRecord, retryAfter,
  windowsFromUsagePayload, anthropicLimitsFromHeaders, codexLimitsFromHeaders,
  codexStreamLimits, codexUsageLimits, parseConsumeResetResult, parseResetCreditSnapshot,
  discoverSubscriptionModels, adminRequest, usageRequest, refreshResponseBody, refreshNetworkError,
  CREDENTIAL_ERROR_IDENTIFIERS, MODEL_ERROR_IDENTIFIERS
} from "./shared.js";
import type {
  SubscriptionProvider, SubscriptionStreamOutcome, AdminUsageRange, AdminUsageCost,
  ConsumeResetCreditInput, ConsumeResetCreditResult
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
    loadCredential: (path) => loadSubscriptionCredential(mode, path),
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
    refresh: async (credential, signal) => {
      if (credential.refreshToken === undefined) {
        throw new SubscriptionRefreshError({
          kind: "permanent",
          reasonCode: "missing_refresh_token"
        });
      }
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: info.oauth.clientId
      });
      try {
        const response = await fetch(info.oauth.tokenEndpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded"
          },
          body,
          ...(signal !== undefined ? { signal } : {})
        });
        const { body: responseBody, hasJsonBody } = await decodeJsonBody(response);
        if (response.ok && !hasJsonBody) {
          throw new SubscriptionRefreshError({
            kind: "transient",
            status: response.status,
            failureKind: "protocol"
          });
        }
        return await refreshResponseBody(response, responseBody, credential);
      } catch (error) {
        return refreshNetworkError(error);
      }
    },
    fetchUsage: async (credential, signal) => {
      const payload = await usageRequest(
        info.oauth.usageEndpoint,
        {
          authorization: `Bearer ${credential.accessToken}`,
          ...(credential.accountId !== undefined
            ? { "chatgpt-account-id": credential.accountId }
            : {})
        },
        signal
      );
      return codexUsageLimits(payload);
    },
    fetchResetCredits: async (credential, signal) => {
      const endpoint = info.oauth.resetCreditsEndpoint;
      if (endpoint === undefined) {
        throw new Error("Codex reset-credits endpoint is not configured");
      }
      const payload = await usageRequest(
        endpoint,
        {
          authorization: `Bearer ${credential.accessToken}`,
          ...(credential.accountId !== undefined
            ? { "chatgpt-account-id": credential.accountId }
            : {})
        },
        signal
      );
      return parseResetCreditSnapshot(payload);
    },
    consumeResetCredit: async (credential, input, signal) => {
      const endpoint = info.oauth.resetCreditsEndpoint;
      if (endpoint === undefined) {
        throw new Error("Codex reset-credits endpoint is not configured");
      }
      if (input.redeemRequestId.trim().length === 0) {
        throw new Error("redeemRequestId is required");
      }
      const creditId = input.creditId?.trim();
      if (input.creditId !== undefined && (creditId === undefined || creditId.length === 0)) {
        throw new Error("creditId must not be empty");
      }
      const response = await fetch(`${endpoint}/consume`, {
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
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (!response.ok && body === undefined) {
        throw new Error(`Codex reset-credit consume returned ${response.status}`);
      }
      const result = parseConsumeResetResult(body, input.redeemRequestId, response.ok);
      if (!response.ok && !result.ok) {
        // Prefer structured business codes when present; otherwise surface HTTP.
        if (result.code === "http_error") {
          throw new Error(`Codex reset-credit consume returned ${response.status}`);
        }
      }
      return result;
    },
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
    fetchAdminUsageCost: async (adminKey, range, signal) => {
      const query = new URLSearchParams({
        start_time: String(Math.floor(range.startTime)),
        bucket_width: "1d",
        limit: "31"
      });
      if (range.endTime !== undefined) query.set("end_time", String(Math.floor(range.endTime)));
      const headers = { authorization: `Bearer ${adminKey}` };
      const [usage, cost] = await Promise.all([
        adminRequest(info.admin.usageEndpoint, query, headers, signal),
        adminRequest(info.admin.costEndpoint, query, headers, signal)
      ]);
      return { usage, cost };
    }
  };
}

