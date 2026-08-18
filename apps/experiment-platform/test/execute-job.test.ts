import assert from "node:assert/strict";
import test from "node:test";

import { promptFromInput } from "../src/lib/hosted-request.ts";

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
