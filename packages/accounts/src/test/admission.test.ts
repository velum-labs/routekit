import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasUsableCredits,
  isPoolEligible,
  poolReadiness,
  windowAdmissionStatus
} from "../admission.js";

test("hasUsableCredits recognizes team credit signals", () => {
  assert.equal(hasUsableCredits({ hasCredits: true, unlimited: false }), true);
  assert.equal(hasUsableCredits({ hasCredits: false, unlimited: false }), false);
  assert.equal(hasUsableCredits({ unlimited: true }), true);
  assert.equal(hasUsableCredits(undefined), false);
});

test("pool eligibility keeps credit-backed members over the switch threshold", () => {
  const limits = {
    windows: {
      primary: {
        utilization: 1,
        observedAt: 1,
        source: "usage" as const
      }
    },
    observedAt: 1,
    source: "usage" as const,
    completeness: "snapshot" as const,
    credits: { hasCredits: true, unlimited: false }
  };
  assert.equal(isPoolEligible({ limits, switchThreshold: 0.9 }), true);
  assert.equal(
    isPoolEligible({
      limits: { ...limits, credits: { hasCredits: false, unlimited: false } },
      switchThreshold: 0.9
    }),
    false
  );
});

test("window admission status distinguishes credits-only pressure from exhaustion", () => {
  assert.equal(windowAdmissionStatus(0.5, 0.9, { hasCredits: true }), "ok");
  assert.equal(
    windowAdmissionStatus(1, 0.9, { hasCredits: true, unlimited: false }),
    "credits-only"
  );
  assert.equal(windowAdmissionStatus(1, 0.9, { hasCredits: false, unlimited: false }), "exhausted");
  assert.equal(windowAdmissionStatus(1, 0.9, undefined, "rejected"), "rejected");
});

test("provider rejected and exceeded statuses block even with billing credits", () => {
  for (const status of ["rejected", "exceeded"] as const) {
    const readiness = poolReadiness({
      limits: {
        windows: {
          primary: { utilization: 0.1, status, observedAt: 1, source: "usage" }
        },
        credits: { hasCredits: true, unlimited: true },
        observedAt: 1,
        source: "usage",
        completeness: "snapshot"
      },
      switchThreshold: 0.9
    });
    assert.equal(readiness.eligible, false);
    assert.deepEqual(readiness.reasons, [
      {
        code: `provider_quota_${status}`,
        window: "primary",
        status
      }
    ]);
  }
});

test("readiness returns stable structured threshold and local policy reasons", () => {
  const readiness = poolReadiness({
    limits: {
      windows: {
        primary: { utilization: 0.9, observedAt: 1, source: "usage" }
      },
      credits: { hasCredits: false },
      observedAt: 1,
      source: "usage",
      completeness: "snapshot"
    },
    switchThreshold: 0.9,
    coolingUntil: 200,
    credentialExpiresAt: 90,
    catalogReady: true,
    models: ["available"],
    model: "missing",
    now: 100
  });
  assert.equal(readiness.eligible, false);
  assert.deepEqual(
    readiness.reasons.map((reason) => reason.code),
    ["model_unavailable", "cooldown_active", "credential_expired", "quota_switch_threshold"]
  );
});
