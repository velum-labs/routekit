import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EFFORT_QUALIFIED_MODEL_CODEC,
  effortQualifiedClientModel,
  enumerateModelEffortVariants,
  modelEffortVariantCollisions,
  parseReasoningSelection,
  reasoningEffortDescriptors,
  reasoningSelectionEquals,
  reasoningSelectionFromEffort,
  resolveModelEffortVariant,
  resolveReasoningSelection
} from "../index.js";
import type { ModelReasoningCapabilities } from "../index.js";

const SUPPORTED: ModelReasoningCapabilities = {
  status: "supported",
  efforts: [
    { id: "quick", label: "Quick" },
    { id: "deep", description: "Deep think", aliases: ["max", "xhigh"] },
    { id: "deep" },
    { id: "" },
    { id: "max-budget", aliases: ["deep"] }
  ],
  adaptive: true,
  budget: { minTokens: 1_024, maxTokens: 8_192 },
  provenance: "provider"
};

test("reasoningEffortDescriptors keeps provider order, labels, and unique ids", () => {
  assert.deepEqual(reasoningEffortDescriptors(SUPPORTED), [
    { id: "quick", label: "Quick", aliases: [] },
    { id: "deep", label: "Deep think", aliases: ["max", "xhigh"] },
    { id: "max-budget", label: "max-budget", aliases: ["deep"] }
  ]);
  assert.deepEqual(
    reasoningEffortDescriptors({ status: "unsupported", provenance: "provider" }),
    []
  );
  assert.deepEqual(reasoningEffortDescriptors(undefined), []);
});

test("resolveReasoningSelection validates modes and normalizes effort aliases", () => {
  assert.deepEqual(
    resolveReasoningSelection(SUPPORTED, { mode: "effort", effort: "max" }),
    { ok: true, selection: { mode: "effort", effort: "deep" } }
  );
  assert.deepEqual(
    reasoningSelectionFromEffort(SUPPORTED, "unknown"),
    {
      ok: false,
      code: "unsupported_effort",
      message: 'reasoning effort "unknown" is not supported'
    }
  );
  assert.equal(
    resolveReasoningSelection(SUPPORTED, { mode: "adaptive" }).ok,
    true
  );
  assert.equal(
    resolveReasoningSelection(
      { ...SUPPORTED, adaptive: false },
      { mode: "adaptive" }
    ).ok,
    false
  );
  assert.equal(
    resolveReasoningSelection(SUPPORTED, {
      mode: "budget",
      budgetTokens: 512
    }).ok,
    false
  );
  const missing = resolveReasoningSelection(undefined, {
    mode: "effort",
    effort: "deep"
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "unknown_capability");
});

test("parseReasoningSelection and equality cover the canonical union", () => {
  assert.deepEqual(parseReasoningSelection({ mode: "auto" }), {
    ok: true,
    selection: { mode: "auto" }
  });
  assert.equal(parseReasoningSelection({ mode: "effort" }).ok, false);
  assert.equal(
    parseReasoningSelection({ mode: "effort", effort: "deep", budgetTokens: 1 })
      .ok,
    false
  );
  assert.equal(
    reasoningSelectionEquals(
      { mode: "effort", effort: "deep" },
      { mode: "effort", effort: "deep" }
    ),
    true
  );
  assert.equal(
    reasoningSelectionEquals(
      { mode: "budget", budgetTokens: 2 },
      { mode: "budget", budgetTokens: 3 }
    ),
    false
  );
});

test("enumerateModelEffortVariants emits base plus opaque efforts only", () => {
  assert.deepEqual(
    enumerateModelEffortVariants({
      model: "openai/gpt-5.5",
      clientModel: "claude-openai/gpt-5.5",
      reasoning: SUPPORTED
    }),
    [
      {
        id: "claude-openai/gpt-5.5",
        model: "openai/gpt-5.5",
        selection: { mode: "auto" }
      },
      {
        id: "claude-openai/gpt-5.5:quick",
        model: "openai/gpt-5.5",
        selection: { mode: "effort", effort: "quick" },
        effort: { id: "quick", label: "Quick", aliases: [] }
      },
      {
        id: "claude-openai/gpt-5.5:deep",
        model: "openai/gpt-5.5",
        selection: { mode: "effort", effort: "deep" },
        effort: { id: "deep", label: "Deep think", aliases: ["max", "xhigh"] }
      },
      {
        id: "claude-openai/gpt-5.5:max-budget",
        model: "openai/gpt-5.5",
        selection: { mode: "effort", effort: "max-budget" },
        effort: { id: "max-budget", label: "max-budget", aliases: ["deep"] }
      }
    ]
  );
});

test("resolveModelEffortVariant prefers exact bases and rejects bad efforts", () => {
  const entries = [
    {
      model: "openai/literal:high",
      clientModel: "routekit/openai/literal:high"
    },
    {
      model: "openai/gpt-5.5",
      clientModel: "routekit/openai/gpt-5.5",
      reasoning: SUPPORTED
    }
  ];

  assert.deepEqual(
    resolveModelEffortVariant("routekit/openai/gpt-5.5:deep", entries),
    {
      ok: true,
      model: "openai/gpt-5.5",
      clientModel: "routekit/openai/gpt-5.5",
      selection: { mode: "effort", effort: "deep" }
    }
  );
  assert.deepEqual(
    resolveModelEffortVariant("openai/gpt-5.5:max", entries),
    {
      ok: true,
      model: "openai/gpt-5.5",
      clientModel: "routekit/openai/gpt-5.5",
      selection: { mode: "effort", effort: "deep" }
    }
  );
  assert.deepEqual(
    resolveModelEffortVariant("routekit/openai/literal:high", entries),
    {
      ok: true,
      model: "openai/literal:high",
      clientModel: "routekit/openai/literal:high",
      selection: { mode: "auto" }
    }
  );
  const unsupported = resolveModelEffortVariant(
    "routekit/openai/gpt-5.5:unknown",
    entries
  );
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.code, "unsupported_effort");
  const unknown = resolveModelEffortVariant("missing/model:deep", entries);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "unknown_model");
  assert.deepEqual(
    modelEffortVariantCollisions([
      {
        model: "a",
        clientModel: "shared",
        reasoning: {
          status: "supported",
          efforts: [{ id: "high" }],
          provenance: "provider"
        }
      },
      {
        model: "b",
        clientModel: "shared",
        reasoning: {
          status: "supported",
          efforts: [{ id: "high" }],
          provenance: "provider"
        }
      }
    ]),
    ["shared", "shared:high"]
  );
});

test("effortQualifiedClientModel projects launch selections", () => {
  assert.equal(
    effortQualifiedClientModel("claude-openai/gpt-5.5", {
      mode: "effort",
      effort: "deep"
    }),
    "claude-openai/gpt-5.5:deep"
  );
  assert.equal(
    effortQualifiedClientModel("claude-openai/gpt-5.5", { mode: "auto" }),
    "claude-openai/gpt-5.5"
  );
  assert.equal(
    EFFORT_QUALIFIED_MODEL_CODEC.effortToken(
      "claude-openai/gpt-5.5:deep",
      "claude-openai/gpt-5.5"
    ),
    "deep"
  );
});
