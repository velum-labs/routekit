import assert from "node:assert/strict";
import { test } from "node:test";

import { subscriptionProvider } from "../index.js";
import { codexModelsSearch } from "../provider.js";

test("Anthropic adapter parses first-party unified subscription windows", () => {
  const provider = subscriptionProvider("claude-code");
  const limits = provider.parseLimits(
    new Headers({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": "1774933200",
      "anthropic-ratelimit-unified-7d-sonnet-status": "rejected",
      "anthropic-ratelimit-unified-7d-sonnet-utilization": "1",
      "anthropic-ratelimit-unified-7d-sonnet-reset": "1775000000"
    })
  );
  assert.deepEqual(Object.keys(limits?.windows ?? {}), [
    "five_hour",
    "seven_day_sonnet"
  ]);
  assert.equal(limits?.windows.five_hour?.utilization, 0.42);
  assert.equal(limits?.windows.five_hour?.resetsAt, 1774933200);
  assert.equal(limits?.windows.seven_day_sonnet?.status, "rejected");
  assert.equal(limits?.windows.seven_day_sonnet?.utilization, 1);
});

test("Anthropic adapter distinguishes quota rejection from a short throttle", () => {
  const provider = subscriptionProvider("claude-code");
  const quota = provider.classify(
    429,
    new Headers({
      "anthropic-ratelimit-unified-7d-status": "rejected",
      "anthropic-ratelimit-unified-7d-utilization": "1",
      "anthropic-ratelimit-unified-7d-reset": "1775000000"
    }),
    { error: { message: "weekly limit reached" } }
  );
  assert.equal(quota?.category, "quota_exhausted");
  assert.equal(quota?.resetsAt, 1775000000);

  const throttle = provider.classify(
    429,
    new Headers({ "retry-after": "2" }),
    { error: { message: "temporarily rate limited" } }
  );
  assert.equal(throttle?.category, "transient");
  assert.equal(throttle?.retryAfter, 2);
});

test("Codex adapter parses dynamic limit headers and stream rate-limit events", () => {
  const provider = subscriptionProvider("codex");
  const headers = provider.parseLimits(
    new Headers({
      "x-codex-active-limit": "codex_other",
      "x-codex-other-primary-used-percent": "35",
      "x-codex-other-primary-window-minutes": "300",
      "x-codex-other-primary-reset-at": "1774933200",
      "x-codex-other-secondary-used-percent": "1",
      "x-codex-other-secondary-window-minutes": "10080",
      "x-codex-other-limit-name": "gpt-5.3-codex",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-balance": "$12.00"
    })
  );
  assert.equal(headers?.windows["codex_other:primary"]?.utilization, 0.35);
  assert.equal(headers?.windows["codex_other:primary"]?.windowSeconds, 18_000);
  assert.equal(headers?.windows["codex_other:primary"]?.limitName, "gpt-5.3-codex");
  assert.equal(headers?.windows["codex_other:secondary"]?.utilization, 0.01);
  assert.equal(headers?.credits?.balance, "$12.00");

  const stream = provider.parseStreamEvent({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 1, reset_at: 1774933300 },
        secondary: { used_percent: 50, reset_at: 1775000000 }
      }
    }
  });
  assert.equal(stream?.windows.primary?.utilization, 0.01);
  assert.equal(stream?.windows.secondary?.utilization, 0.5);

  const response = provider.parseLimits(new Headers(), {
    rate_limit: {
      primary_window: { used_percent: 1, reset_at: 1774933300 }
    }
  });
  assert.equal(response?.source, "response");
  assert.equal(response?.completeness, "partial");
  assert.equal(response?.windows.primary?.source, "response");
  assert.equal(response?.windows.primary?.utilization, 0.01);
});

test("Codex adapter recognizes usage_limit_reached as quota exhaustion", () => {
  const failure = subscriptionProvider("codex").classify(
    429,
    new Headers(),
    {
      error: {
        error_type: "usage_limit_reached",
        message: "weekly usage limit reached",
        resets_at: 1775000000
      }
    }
  );
  assert.equal(failure?.category, "quota_exhausted");
  assert.equal(failure?.resetsAt, 1775000000);
});

test("Codex adapter parses banked reset credits from usage payloads", async () => {
  const provider = subscriptionProvider("codex");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 1, reset_at: 1774933300 }
      },
      rate_limit_reset_credits: {
        available_count: 2,
        credits: [
          {
            credit_id: "RateLimitResetCredit_a",
            status: "available",
            expires_at: "2026-08-01T00:00:00Z",
            title: "Launch reset"
          }
        ]
      }
    });
  try {
    const limits = await provider.fetchUsage({
      mode: "codex",
      accessToken: "token",
      sourcePath: "/tmp/codex.json"
    });
    assert.equal(limits.resetCredits?.availableCount, 2);
    assert.equal(typeof limits.resetCredits?.observedAt, "number");
    assert.equal(limits.resetCredits?.credits?.[0]?.id, "RateLimitResetCredit_a");
    assert.equal(limits.windows.primary?.utilization, 0.01);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex adapter lists and consumes banked rate-limit resets", async () => {
  const provider = subscriptionProvider("codex");
  assert.equal(typeof provider.fetchResetCredits, "function");
  assert.equal(typeof provider.consumeResetCredit, "function");
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, ...(body !== undefined ? { body } : {}) });
    if (url.endsWith("/wham/rate-limit-reset-credits") && method === "GET") {
      return Response.json({
        available_count: 1,
        credits: [
          {
            id: "RateLimitResetCredit_b",
            reset_type: "codex_rate_limits",
            status: "available",
            expires_at: 1780000000
          }
        ]
      });
    }
    if (url.endsWith("/wham/rate-limit-reset-credits/consume") && method === "POST") {
      const parsed = body === undefined ? undefined : JSON.parse(body) as {
        redeem_request_id?: string;
        credit_id?: string;
      };
      if (parsed?.redeem_request_id === "req-already") {
        return Response.json({ code: "alreadyRedeemed" });
      }
      return Response.json({
        code: "reset",
        credit_id: parsed?.credit_id ?? "RateLimitResetCredit_b",
        windows_reset: 1
      });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const listed = await provider.fetchResetCredits!({
      mode: "codex",
      accessToken: "token",
      accountId: "acct",
      sourcePath: "/tmp/codex.json"
    });
    assert.equal(listed.availableCount, 1);
    assert.equal(typeof listed.observedAt, "number");
    assert.equal(listed.credits?.[0]?.id, "RateLimitResetCredit_b");

    const consumed = await provider.consumeResetCredit!(
      {
        mode: "codex",
        accessToken: "token",
        accountId: "acct",
        sourcePath: "/tmp/codex.json"
      },
      { creditId: "RateLimitResetCredit_b", redeemRequestId: "req-1" }
    );
    assert.equal(consumed.ok, true);
    assert.equal(consumed.code, "reset");
    assert.equal(consumed.creditId, "RateLimitResetCredit_b");
    assert.equal(consumed.windowsReset, 1);
    assert.equal(consumed.redeemRequestId, "req-1");
    assert.equal(calls[1]?.body, JSON.stringify({
      redeem_request_id: "req-1",
      credit_id: "RateLimitResetCredit_b"
    }));

    const already = await provider.consumeResetCredit!(
      {
        mode: "codex",
        accessToken: "token",
        sourcePath: "/tmp/codex.json"
      },
      { creditId: "RateLimitResetCredit_b", redeemRequestId: "req-already" }
    );
    assert.equal(already.ok, false);
    assert.equal(already.code, "already_redeemed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex model discovery supplies the required client version query", () => {
  assert.equal(codexModelsSearch("", "0.144.5"), "?client_version=0.144.5");
  assert.equal(
    codexModelsSearch("?include_hidden=true", "0.144.5"),
    "?include_hidden=true&client_version=0.144.5"
  );
  assert.equal(
    codexModelsSearch("?client_version=0.142.5", "0.144.5"),
    "?client_version=0.142.5"
  );
});

test("subscription adapters discover native models with member credentials", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    return url.includes("anthropic")
      ? Response.json({
          data: [
            {
              id: "claude-fable-5",
              capabilities: {
                effort: {
                  supported: true,
                  low: { supported: true },
                  medium: { supported: true },
                  high: { supported: true },
                  xhigh: null,
                  max: { supported: false }
                },
                thinking: {
                  supported: true,
                  types: {
                    adaptive: { supported: true },
                    enabled: { supported: true }
                  }
                }
              }
            }
          ]
        })
      : Response.json({
          models: [
            {
              slug: "gpt-5.5",
              supported_reasoning_levels: ["quick", "deep"],
              default_reasoning_level: "deep"
            }
          ]
        });
  };
  try {
    const claude = await subscriptionProvider("claude-code").discoverModels({
      mode: "claude-code",
      accessToken: "claude-token",
      sourcePath: "/tmp/claude.json"
    });
    const codex = await subscriptionProvider("codex").discoverModels({
      mode: "codex",
      accessToken: "codex-token",
      accountId: "acct",
      sourcePath: "/tmp/codex.json"
    });
    const claudeModel =
      typeof claude[0] === "string" ? undefined : claude[0];
    assert.ok(claudeModel);
    assert.equal(claudeModel.id, "claude-fable-5");
    assert.deepEqual(claudeModel.reasoning?.efforts, [
      { id: "low" },
      { id: "medium" },
      { id: "high" }
    ]);
    assert.deepEqual(claudeModel.reasoning?.budget, { minTokens: 1_024 });
    assert.equal(claudeModel.reasoning?.adaptive, true);
    assert.equal(claudeModel.reasoning?.defaultEffort, undefined);
    assert.equal(typeof codex[0] === "string" ? codex[0] : codex[0]?.id, "gpt-5.5");
    assert.deepEqual(
      typeof codex[0] === "string" ? undefined : codex[0]?.reasoning?.efforts,
      [{ id: "quick" }, { id: "deep" }]
    );
    assert.equal(requests[0]?.headers.get("authorization"), "Bearer claude-token");
    assert.equal(requests[0]?.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(requests[1]?.headers.get("authorization"), "Bearer codex-token");
    assert.equal(requests[1]?.headers.get("chatgpt-account-id"), "acct");
    assert.equal(requests[1]?.headers.get("originator"), "routekit");
    assert.match(requests[1]?.url ?? "", /[?&]client_version=[^&]+/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
