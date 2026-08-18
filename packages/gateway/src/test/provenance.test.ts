import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildModelCallRecord,
  readProducerVersion,
  resolveProducerGitSha,
  UNKNOWN_GIT_SHA
} from "../provenance.js";

const GIT_SHA = /^[a-f0-9]{40}$/;

test("WS7: resolveProducerGitSha returns a real 40-hex SHA from a source checkout", () => {
  const previous = process.env.ROUTEKIT_BUILD_GIT_SHA;
  delete process.env.ROUTEKIT_BUILD_GIT_SHA;
  try {
    // The test runs from the source checkout (not node_modules), so the
    // runtime reads .git/HEAD and resolves the real producer SHA.
    const sha = resolveProducerGitSha();
    assert.match(sha, GIT_SHA, "a checkout resolves a real git SHA");
    assert.notEqual(sha, "0".repeat(40), "never the all-zero faked-provenance placeholder");
  } finally {
    if (previous !== undefined) process.env.ROUTEKIT_BUILD_GIT_SHA = previous;
  }
});

test("WS7: a build-time stamp wins over the checkout git lookup", () => {
  const previous = process.env.ROUTEKIT_BUILD_GIT_SHA;
  const stamped = "a".repeat(40);
  process.env.ROUTEKIT_BUILD_GIT_SHA = stamped;
  try {
    assert.equal(resolveProducerGitSha(), stamped);
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_BUILD_GIT_SHA;
    else process.env.ROUTEKIT_BUILD_GIT_SHA = previous;
  }
});

test("WS7: an installed copy (node_modules, no stamp) falls back to the 'unknown' sentinel", () => {
  const previous = process.env.ROUTEKIT_BUILD_GIT_SHA;
  delete process.env.ROUTEKIT_BUILD_GIT_SHA;
  try {
    // A node_modules path is treated as an installed artifact: no git lookup
    // (so we never mis-report the consumer's repo) → the clearly-marked sentinel.
    const sha = resolveProducerGitSha(
      "/tmp/project/node_modules/@velum-labs/routekit-gateway/dist"
    );
    assert.equal(sha, UNKNOWN_GIT_SHA);
    assert.equal(sha, "unknown");
    assert.notEqual(sha, "0".repeat(40), "the sentinel is never 40 zeros");
  } finally {
    if (previous !== undefined) process.env.ROUTEKIT_BUILD_GIT_SHA = previous;
  }
});

test("WS7: readProducerVersion reads this package's real version", () => {
  const version = readProducerVersion();
  assert.match(version, /^\d+\.\d+\.\d+/, "a real semver, not the 0.1.0 stub");
});

test("WS7: a built model-call record carries normalized provenance", () => {
  const record = buildModelCallRecord(
    {
      callId: "call_test_1",
      dialect: "openai-chat",
      requestedModel: "gpt-5.5",
      model: "gpt-5.5",
      stream: false,
      requestBody: { messages: [{ role: "user", content: "hi" }] },
      startedAt: "2026-06-27T00:00:00.000Z",
      attribution: {
        effective_model: "openai/gpt-5.5",
        native_model: "gpt-5.5",
        provider: "openai",
        billing_mode: "api_key",
        attempts: 1,
        retries: 0,
        account_failovers: 0
      }
    },
    { statusCode: 200, durationMs: 12, responseBody: Buffer.from(JSON.stringify({ id: "x" })) }
  );
  assert.equal(record.call_id, "call_test_1");
  assert.equal(record.endpoint_id, "openai-chat");
  assert.equal(record.status, "succeeded");
  assert.equal(record.metadata?.unknown_cost, true);
  assert.deepEqual(record.metadata?.attribution, {
    effective_model: "openai/gpt-5.5",
    native_model: "gpt-5.5",
    provider: "openai",
    billing_mode: "api_key",
    attempts: 1,
    retries: 0,
    account_failovers: 0
  });
});

test("compositional routing provenance is complete, sanitized, and binds the inference call", () => {
  const record = buildModelCallRecord(
    {
      callId: "model_call_inference",
      dialect: "openai-responses",
      requestedModel: "auto",
      model: "openai/model-b",
      stream: false,
      requestBody: { model: "openai/model-b", input: "private request" },
      startedAt: "2026-08-17T00:00:00.000Z",
      attribution: {
        effective_model: "openai/model-b",
        provider: "openai",
        billing_mode: "api_key",
        compositional_routing: {
          version: 2,
          basis_digest: "definitions-v2",
          evidence_digest: "evidence-v2",
          weights: [
            { dimension_id: "gateway-protocols", weight: 0.6 },
            { dimension_id: "eval-driven-routing", weight: 0.4 }
          ],
          unknown_weight: 0,
          requirements: {
            endpoint: "responses",
            requires_tools: true,
            requires_vision: false,
            input_tokens: 120,
            max_output_tokens: 800
          },
          objective: { kind: "highest-quality" },
          candidates: [
            {
              model: "openai/model-b",
              eligible: true,
              exclusion_reasons: [],
              quality: 0.91,
              failure_rate: 0.02,
              p95_duration_ms: 900,
              cost_status: "unavailable",
              utility: 0.91,
              rank: 1
            },
            {
              model: "openai/model-a",
              eligible: false,
              exclusion_reasons: ["missing_area_evidence:eval-driven-routing"],
              cost_status: "unavailable"
            }
          ],
          selected_model: "openai/model-b",
          fallback_models: [],
          classifier_call_id: "model_call_classifier"
        },
        attempts: 1,
        retries: 0,
        account_failovers: 0
      }
    },
    {
      statusCode: 200,
      durationMs: 12,
      responseBody: Buffer.from(JSON.stringify({ id: "response-id" }))
    }
  );
  const routing = (
    record.metadata?.attribution as { compositional_routing?: Record<string, unknown> } | undefined
  )?.compositional_routing;
  assert.equal(routing?.classifier_call_id, "model_call_classifier");
  assert.equal(routing?.inference_call_id, "model_call_inference");
  assert.equal(routing?.basis_digest, "definitions-v2");
  assert.equal(routing?.evidence_digest, "evidence-v2");
  assert.deepEqual(routing?.weights, [
    { dimension_id: "gateway-protocols", weight: 0.6 },
    { dimension_id: "eval-driven-routing", weight: 0.4 }
  ]);
  assert.doesNotMatch(JSON.stringify(routing), /private request/);
});

test("model-call provenance replaces raw upstream errors with a safe summary", () => {
  const secret = "sk-secret-must-not-survive";
  const record = buildModelCallRecord(
    {
      callId: "call_redacted",
      dialect: "openai-chat",
      requestedModel: "openai/gpt-5.5",
      model: "openai/gpt-5.5",
      stream: false,
      requestBody: { messages: [{ role: "user", content: "hi" }] },
      startedAt: "2026-06-27T00:00:00.000Z"
    },
    {
      statusCode: 502,
      durationMs: 2,
      error: new Error(`authorization Bearer ${secret}`)
    }
  );
  assert.equal(record.error?.message, "provider request failed");
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(record), /authorization/i);
});

test("an unconfigured router is not attributed to a provider or marked retryable", () => {
  const record = buildModelCallRecord(
    {
      callId: "call_no_route",
      dialect: "anthropic-messages",
      requestedModel: undefined,
      model: undefined,
      stream: false,
      requestBody: { messages: [{ role: "user", content: "hi" }] },
      startedAt: "2026-07-22T00:00:00.000Z"
    },
    {
      statusCode: 503,
      durationMs: 1,
      responseBody: Buffer.from(
        JSON.stringify({
          error: {
            type: "unavailable",
            message: "no model is available; configure a provider"
          }
        })
      )
    }
  );
  assert.equal(record.metadata?.attribution, undefined);
  assert.deepEqual(record.error, {
    kind: "capability_missing",
    message: "no model route is configured",
    retryable: false
  });
});

test("model-call provenance meters aggregate buffered and Responses SSE usage", () => {
  const context = {
    callId: "call_aggregate",
    dialect: "openai-responses" as const,
    requestedModel: "gpt-5.5",
    model: "gpt-5.5",
    stream: false,
    requestBody: { input: "research" },
    startedAt: "2026-06-27T00:00:00.000Z"
  };
  const buffered = buildModelCallRecord(context, {
    statusCode: 200,
    durationMs: 3,
    responseBody: Buffer.from(
      JSON.stringify({
        usage: {
          input_tokens: 30,
          output_tokens: 12,
          total_tokens: 42
        }
      })
    )
  });
  assert.deepEqual(buffered.usage, {
    prompt_tokens: 30,
    completion_tokens: 12,
    total_tokens: 42
  });
  assert.equal(buffered.metadata?.cost_estimate_usd, 0.0001575);

  const streamed = buildModelCallRecord(
    { ...context, callId: "call_aggregate_stream", stream: true },
    {
      statusCode: 200,
      durationMs: 3,
      responseBody: Buffer.from(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 30,
              output_tokens: 12,
              total_tokens: 42
            }
          }
        })}\n\n`
      )
    }
  );
  assert.deepEqual(streamed.usage, buffered.usage);
  assert.equal(streamed.metadata?.cost_estimate_usd, 0.0001575);
});

test("HTTP 200 Codex terminal SSE quota failure is rate-limited provenance", () => {
  const body = Buffer.from(
    'event: response.failed\ndata: {"response":{"error":{"type":"usage_limit_reached","code":"weekly","message":"spent"}}}\n\n'
  );
  const record = buildModelCallRecord(
    {
      callId: "call_sse_quota",
      dialect: "openai-responses",
      requestedModel: "codex/gpt-5.5",
      model: "codex/gpt-5.5",
      stream: true,
      requestBody: { model: "codex/gpt-5.5", input: "hi", stream: true },
      startedAt: "2026-07-29T00:00:00.000Z"
    },
    { statusCode: 200, durationMs: 5, responseBody: body }
  );
  assert.equal(record.status, "failed");
  assert.equal(record.error?.kind, "rate_limited");
  assert.equal(record.error?.retryable, true);
});
