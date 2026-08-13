import { providerDefaultBaseUrl, subscriptionInfo } from "@velum-labs/routekit-registry";
import { fetchViaHttpClient } from "@velum-labs/routekit-runtime/effect";
import { loadSubscriptionCredential } from "../credentials.js";
import { decodeJsonBody } from "../subscription-http.js";
import type {
  AccountLimits,
  RateLimitDiagnostic,
  RateLimitWindow,
  SubscriptionCredential
} from "../types.js";
import type { SubscriptionProvider } from "./shared.js";
import {
  adminRequest,
  authenticationFailure,
  canonicalRateLimitWindowKey,
  defineWindow,
  discoverSubscriptionModels,
  epochSeconds,
  errorMessage,
  refreshNetworkError,
  refreshResponseBody,
  retryAfter,
  SubscriptionRefreshError,
  usageRequest,
  utilization,
  windowsFromUsagePayload
} from "./shared.js";

export function anthropicProvider(): SubscriptionProvider<"claude-code"> {
  const mode = "claude-code" as const;
  const info = subscriptionInfo(mode);
  return {
    mode,
    upstreamBaseUrl: providerDefaultBaseUrl("anthropic") ?? "https://api.anthropic.com",
    requestPath: "/v1/messages",
    loadCredential: (path) => loadSubscriptionCredential(mode, path),
    discoverModels: (credential, signal) =>
      discoverSubscriptionModels(
        mode,
        providerDefaultBaseUrl("anthropic") ?? "https://api.anthropic.com",
        thisAnthropicHeaders(info, credential),
        signal
      ),
    authHeaders: (credential) => ({
      authorization: `Bearer ${credential.accessToken}`,
      "anthropic-beta": info.oauthBetaHeader ?? "oauth-2025-04-20"
    }),
    refresh: async (credential, signal) => {
      if (credential.refreshToken === undefined) {
        throw new SubscriptionRefreshError({
          kind: "permanent",
          reasonCode: "missing_refresh_token"
        });
      }
      try {
        const response = await fetchViaHttpClient(info.oauth.tokenEndpoint, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: credential.refreshToken,
            client_id: info.oauth.clientId
          }),
          ...(signal !== undefined ? { signal } : {})
        });
        const { body, hasJsonBody } = await decodeJsonBody(response);
        if (response.ok && !hasJsonBody) {
          throw new SubscriptionRefreshError({
            kind: "transient",
            status: response.status,
            failureKind: "protocol"
          });
        }
        return await refreshResponseBody(response, body, credential);
      } catch (error) {
        return refreshNetworkError(error);
      }
    },
    fetchUsage: async (credential, signal) => {
      const payload = await usageRequest(
        info.oauth.usageEndpoint,
        {
          ...thisAnthropicHeaders(info, credential)
        },
        signal
      );
      const observedAt = Date.now() / 1000;
      const parsed = windowsFromUsagePayload(mode, payload, observedAt, "usage");
      return {
        windows: parsed.windows,
        ...(parsed.diagnostics.length > 0 ? { diagnostics: parsed.diagnostics } : {}),
        observedAt,
        source: "usage",
        completeness: "snapshot"
      };
    },
    parseLimits: (headers) => anthropicLimitsFromHeaders(headers),
    parseStreamEvent: () => undefined,
    classify: (status, headers, body) => {
      const authentication = authenticationFailure(status, body, `Anthropic returned ${status}`);
      if (authentication !== undefined) return authentication;
      if (status !== 429 && status < 500) return undefined;
      const limits = anthropicLimitsFromHeaders(headers);
      const rejected = Object.values(limits?.windows ?? {}).some((window) =>
        ["rejected", "exceeded"].includes(window.status?.toLowerCase() ?? "")
      );
      const message = errorMessage(body, `Anthropic returned ${status}`);
      const quota =
        rejected || /(?:usage|weekly|five.?hour).*(?:limit|quota)|limit reached/i.test(message);
      const retryAfterSeconds = retryAfter(headers, mode);
      const resetsAt = Math.min(
        ...Object.values(limits?.windows ?? {})
          .map((window) => window.resetsAt)
          .filter((value): value is number => value !== undefined)
      );
      return {
        category: quota ? "quota_exhausted" : "transient",
        status,
        message,
        ...(retryAfterSeconds !== undefined ? { retryAfter: retryAfterSeconds } : {}),
        ...(Number.isFinite(resetsAt) ? { resetsAt } : {})
      };
    },
    fetchAdminUsageCost: async (adminKey, range, signal) => {
      const query = new URLSearchParams({
        starting_at: new Date(range.startTime * 1000).toISOString(),
        bucket_width: "1d"
      });
      if (range.endTime !== undefined) {
        query.set("ending_at", new Date(range.endTime * 1000).toISOString());
      }
      const headers = {
        "x-api-key": adminKey,
        "anthropic-version": "2023-06-01"
      };
      const [usage, cost] = await Promise.all([
        adminRequest(info.admin.usageEndpoint, query, headers, signal),
        adminRequest(info.admin.costEndpoint, query, headers, signal)
      ]);
      return { usage, cost };
    }
  };
}

function thisAnthropicHeaders(
  info: ReturnType<typeof subscriptionInfo>,
  credential: SubscriptionCredential
): Record<string, string> {
  return {
    authorization: `Bearer ${credential.accessToken}`,
    "anthropic-beta": info.oauthBetaHeader ?? "oauth-2025-04-20"
  };
}

function anthropicLimitsFromHeaders(headers: Headers): AccountLimits | undefined {
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
