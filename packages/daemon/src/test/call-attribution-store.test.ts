import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCallRecord } from "@velum-labs/routekit-gateway";

import { CallAttributionStore, callInspection } from "../call-attribution-store.js";

function modelCall(callId: string, seat = "seat_0123456789abcdef"): ModelCallRecord {
  return {
    call_id: callId,
    endpoint_id: "codex/gpt-5.3-codex",
    model: "codex/gpt-5.3-codex",
    request_hash: "sha256:request",
    response_hash: "sha256:response",
    messages: [{ role: "user", content: "sha256:message" }],
    status: "succeeded",
    side_effects: "none",
    started_at: "2026-07-22T00:00:00.000Z",
    finished_at: "2026-07-22T00:00:01.000Z",
    latency_ms: 1_000,
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15
    },
    metadata: {
      attribution: {
        effective_model: "codex/gpt-5.3-codex",
        native_model: "gpt-5.3-codex",
        provider: "codex",
        billing_mode: "subscription",
        account: { seat },
        auto_routing: {
          profile_id: "backend",
          selected_model: "codex/gpt-5.3-codex",
          evidence_digest: "evidence-backend",
          scores: [
            { profile_id: "backend", probability: 0.8 },
            { profile_id: "react", probability: 0.2 }
          ]
        },
        compositional_routing: {
          version: 2,
          mode: "shadow",
          definition_set_digest: "definitions-v2",
          evidence_digest: "evidence-v2",
          weights: [
            { area_id: "gateway-protocols", weight: 0.7 },
            { area_id: "eval-driven-routing", weight: 0.2 }
          ],
          unknown_weight: 0.1,
          requirements: {
            endpoint: "responses",
            requires_tools: true,
            requires_vision: false,
            input_tokens: 100,
            max_output_tokens: 500
          },
          objective: {
            kind: "balanced",
            minimum_quality: 0.75,
            weights: { quality: 0.6, cost: 0.2, latency: 0.2 }
          },
          candidates: [
            {
              model: "openai/gpt-5.6-sol",
              eligible: true,
              exclusion_reasons: [],
              quality: 0.9,
              failure_rate: 0.05,
              p95_duration_ms: 750,
              cost_status: "unavailable",
              utility: 0.85,
              rank: 1
            },
            {
              model: "openai/gpt-5.6-terra",
              eligible: false,
              exclusion_reasons: ["vision_not_supported"],
              cost_status: "unavailable"
            }
          ],
          selected_model: "openai/gpt-5.6-sol",
          fallback_models: [],
          classifier_call_id: "model_call_classifier",
          inference_call_id: callId
        },
        eval: {
          purpose: "eval",
          role: "candidate",
          run_id: "comparison-1",
          case_id: "case-1",
          policy_bypass: true
        },
        attempts: 3,
        retries: 2,
        account_failovers: 1
      },
      unknown_usage: false,
      unknown_cost: false,
      requested_model: "auto",
      cost_estimate_usd: 0.001,
      credential: "must-not-be-returned",
      source_path: "/secret/account.json"
    }
  };
}

test("call inspection exposes attribution while dropping sensitive metadata", () => {
  const inspection = callInspection(modelCall("model_call_safe"));
  assert.ok(inspection);
  assert.equal(inspection.effectiveModel, "codex/gpt-5.3-codex");
  assert.equal(inspection.requestedModel, "auto");
  assert.equal(inspection.account?.seat, "seat_0123456789abcdef");
  assert.deepEqual(inspection.retries, {
    attempts: 3,
    total: 2,
    accountFailovers: 1
  });
  assert.equal(inspection.cost.estimateUsd, 0.001);
  assert.deepEqual(inspection.autoRouting, {
    profileId: "backend",
    selectedModel: "codex/gpt-5.3-codex",
    evidenceDigest: "evidence-backend",
    scores: [
      { profileId: "backend", probability: 0.8 },
      { profileId: "react", probability: 0.2 }
    ]
  });
  assert.deepEqual(inspection.compositionalRouting, {
    version: 2,
    mode: "shadow",
    definitionSetDigest: "definitions-v2",
    evidenceDigest: "evidence-v2",
    weights: [
      { areaId: "gateway-protocols", weight: 0.7 },
      { areaId: "eval-driven-routing", weight: 0.2 }
    ],
    unknownWeight: 0.1,
    requirements: {
      endpoint: "responses",
      requiresTools: true,
      requiresVision: false,
      inputTokens: 100,
      maxOutputTokens: 500
    },
    objective: {
      kind: "balanced",
      minimumQuality: 0.75,
      weights: { quality: 0.6, cost: 0.2, latency: 0.2 }
    },
    candidates: [
      {
        model: "openai/gpt-5.6-sol",
        eligible: true,
        exclusionReasons: [],
        quality: 0.9,
        failureRate: 0.05,
        p95DurationMs: 750,
        costStatus: "unavailable",
        utility: 0.85,
        rank: 1
      },
      {
        model: "openai/gpt-5.6-terra",
        eligible: false,
        exclusionReasons: ["vision_not_supported"],
        costStatus: "unavailable"
      }
    ],
    selectedModel: "openai/gpt-5.6-sol",
    fallbackModels: [],
    classifierCallId: "model_call_classifier",
    inferenceCallId: "model_call_safe"
  });
  assert.deepEqual(inspection.eval, {
    role: "candidate",
    runId: "comparison-1",
    caseId: "case-1",
    policyBypass: true
  });
  assert.doesNotMatch(JSON.stringify(inspection), /must-not-be-returned/);
  assert.doesNotMatch(JSON.stringify(inspection), /secret\/account/);
  assert.equal("messages" in inspection, false);
});

test("call attribution store evicts by capacity and expiry", () => {
  let now = 0;
  const store = new CallAttributionStore({
    limit: 2,
    ttlMs: 100,
    now: () => now
  });
  store.onModelCall(modelCall("call_1"));
  now = 10;
  store.onModelCall(modelCall("call_2"));
  now = 20;
  store.onModelCall(modelCall("call_3"));
  assert.equal(store.get("call_1"), undefined);
  assert.ok(store.get("call_2"));
  assert.equal(store.truncated(), true);
  assert.equal(store.list().length, 2);
  now = 111;
  assert.equal(store.get("call_2"), undefined);
  assert.ok(store.get("call_3"));
});

test("call attribution store applies a tighter live budget on configure", () => {
  const store = new CallAttributionStore({ limit: 3, ttlMs: 60_000 });
  store.onModelCall(modelCall("call_1"));
  store.onModelCall(modelCall("call_2"));
  store.onModelCall(modelCall("call_3"));
  store.configureBudget({ limit: 1, ttlMs: 60_000 });
  assert.equal(store.size(), 1);
  assert.equal(store.list()[0]?.callId, "call_3");
  assert.deepEqual(store.budget(), { limit: 1, ttlMs: 60_000 });
});
