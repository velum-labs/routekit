import assert from "node:assert/strict";
import test from "node:test";

import { promptFromInput } from "../src/lib/hosted-request.ts";
import { providerCostFromPayload } from "../src/lib/provider-cost.ts";

test("hosted inputs select the treatment-specific request", () => {
  const prompt = promptFromInput(
    {
      requests: {
        direct: {
          messages: [{ role: "user", content: "direct" }],
          reasoning_effort: "high",
          seed: 181081
        },
        independent: {
          messages: [{ role: "user", content: "independent" }],
          reasoning: { effort: "high", exclude: true },
          provider: { only: ["openai"] }
        }
      }
    },
    "independent"
  );
  assert.deepEqual(prompt, {
    messages: [{ role: "user", content: "independent" }],
    extra: {
      reasoning: { effort: "high", exclude: true },
      provider: { only: ["openai"] }
    }
  });
});

test("hosted inputs fail closed when a treatment request is missing", () => {
  assert.throws(
    () => promptFromInput({ requests: { direct: { prompt: "hello" } } }, "independent"),
    /no request for treatment/
  );
});

test("provider cost uses AI Gateway BYOK upstream inference cost", () => {
  assert.equal(
    providerCostFromPayload(
      {
        usage: {
          cost: 0,
          is_byok: true,
          market_cost: 0.0024,
          cost_details: {
            upstream_inference_cost: 0.0022
          }
        }
      },
      0.005
    ),
    0.0022
  );
});

test("provider cost supports direct provider cost and safe fallback", () => {
  assert.equal(providerCostFromPayload({ cost: 0.012 }, 0.02), 0.012);
  assert.equal(
    providerCostFromPayload(
      {
        cost_usd: 0.01,
        market_cost: 0.009,
        usage: { cost_details: { upstream_inference_cost: 0.008 } }
      },
      0.02
    ),
    0.008
  );
  assert.equal(providerCostFromPayload({ usage: { cost: 0 } }, 0.02), 0.02);
  assert.equal(providerCostFromPayload(undefined, 0.02), 0.02);
});
