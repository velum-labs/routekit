import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVAL_ATTRIBUTION_HEADER,
  EVAL_POLICY_BYPASS_HEADER
} from "@velum-labs/routekit-eval-contracts";
import { ROUTEKIT_PRINCIPAL_HEADER } from "../auth.js";
import {
  evalAutoRouterRejection,
  evalPolicyBypassRequested,
  evalRequestAttribution
} from "../eval-policy.js";

const evalHeaders = (allowedModels: readonly string[]) => ({
  [EVAL_POLICY_BYPASS_HEADER]: "1",
  [ROUTEKIT_PRINCIPAL_HEADER]: JSON.stringify({
    id: "eval-token",
    label: "eval-session",
    role: "eval",
    evalSession: {
      sessionId: "session-1",
      allowedModels,
      expiresAt: "2026-08-18T23:59:59.000Z"
    }
  })
});

test("eval bypass requires a trusted eval-session principal", () => {
  assert.equal(evalPolicyBypassRequested({ [EVAL_POLICY_BYPASS_HEADER]: "1" }), false);
  assert.equal(
    evalPolicyBypassRequested({
      [EVAL_POLICY_BYPASS_HEADER]: "1",
      [ROUTEKIT_PRINCIPAL_HEADER]: JSON.stringify({ id: "admin", label: "admin", role: "admin" })
    }),
    false
  );
  assert.equal(evalPolicyBypassRequested(evalHeaders(["openai/gpt-5.6-luna"])), true);
});

test("eval sessions reject auto and models outside their allowlist", () => {
  const headers = evalHeaders(["openai/gpt-5.6-luna"]);
  assert.match(evalAutoRouterRejection(headers, "auto") ?? "", /explicit provider\/model/);
  assert.match(
    evalAutoRouterRejection(headers, "openai/gpt-5.6-terra") ?? "",
    /not authorized/
  );
  assert.equal(evalAutoRouterRejection(headers, "openai/gpt-5.6-luna"), undefined);
});

test("eval attribution is accepted only inside an authorized eval session", () => {
  const attribution = JSON.stringify({
    purpose: "eval",
    role: "candidate",
    runId: "run-1",
    caseId: "case-1"
  });
  assert.equal(
    evalRequestAttribution({
      [EVAL_POLICY_BYPASS_HEADER]: "1",
      [EVAL_ATTRIBUTION_HEADER]: attribution
    }),
    undefined
  );
  assert.deepEqual(
    evalRequestAttribution({
      ...evalHeaders(["openai/gpt-5.6-luna"]),
      [EVAL_ATTRIBUTION_HEADER]: attribution
    }),
    {
      purpose: "eval",
      role: "candidate",
      run_id: "run-1",
      case_id: "case-1",
      policy_bypass: true
    }
  );
});
