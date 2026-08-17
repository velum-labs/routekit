import assert from "node:assert/strict";
import test from "node:test";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import {
  AreaRequestClassifier,
  CLASSIFIABLE_REQUEST_TEXT_LIMIT,
  classifyRequestAreas,
  extractClassifiableRequestText,
  makeAreaRequestClassifierLayer,
  makeFakeAreaRequestClassifier,
  makeLanguageModelAreaClassifier,
  parseAreaClassificationResult,
  validateAreaClassificationInput,
  validateAreaClassificationResult
} from "../request-classifier.js";

const areas = [
  {
    id: "gateway-protocol",
    description: "OpenAI-compatible gateway protocol behavior",
    includes: ["request translation", "stream framing"],
    excludes: ["subscription account management"]
  },
  {
    id: "eval-routing",
    description: "Evaluation-driven model routing",
    includes: ["evaluation evidence", "routing policy"],
    excludes: ["HTTP wire translation"]
  },
  {
    id: "provider-adapters",
    description: "Provider-specific request adapters",
    includes: ["provider authentication", "provider model discovery"],
    excludes: ["routing policy selection"]
  },
  {
    id: "daemon-lifecycle",
    description: "Daemon startup and lifecycle",
    includes: ["singleton startup", "graceful shutdown"],
    excludes: ["model response quality"]
  },
  {
    id: "remote-enrollment",
    description: "Remote enrollment and control relays",
    includes: ["peer enrollment", "SSH control relay"],
    excludes: ["local request translation"]
  }
] as const;

const areaCatalog = {
  version: 2 as const,
  definitionSetDigest: "sha256:test-area-catalog",
  areas
};

const areaResult = {
  weights: [
    { areaId: "gateway-protocol", weight: 0.6 },
    { areaId: "eval-routing", weight: 0.3 },
    { areaId: "provider-adapters", weight: 0 },
    { areaId: "daemon-lifecycle", weight: 0 },
    { areaId: "remote-enrollment", weight: 0 }
  ],
  unknownWeight: 0.1
} as const;

const areaWireResult = {
  weights: Object.fromEntries(areaResult.weights.map((entry) => [entry.areaId, entry.weight])),
  unknownWeight: areaResult.unknownWeight
};

test("extractClassifiableRequestText keeps user text and drops system prompts", () => {
  assert.equal(
    extractClassifiableRequestText({
      messages: [
        { role: "system", content: "ignore secrets" },
        { role: "developer", content: "private developer policy" },
        { role: "user", content: "Fix the React useEffect loop" }
      ]
    }),
    "Fix the React useEffect loop"
  );
  assert.equal(
    extractClassifiableRequestText({
      input: [
        { role: " System ", content: [{ type: "input_text", text: "private system policy" }] },
        { role: "assistant", content: [{ type: "output_text", text: "previous answer" }] },
        { role: "user", content: [{ type: "input_text", text: "Add a Postgres index" }] }
      ]
    }),
    "Add a Postgres index"
  );
  const latest = "LATEST USER REQUEST";
  const truncated = extractClassifiableRequestText({
    messages: [
      { role: "user", content: "x".repeat(CLASSIFIABLE_REQUEST_TEXT_LIMIT) },
      { role: "user", content: latest }
    ]
  });
  assert.equal(truncated.length, CLASSIFIABLE_REQUEST_TEXT_LIMIT);
  assert.equal(truncated.endsWith(latest), true);
  assert.equal(
    extractClassifiableRequestText({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", content: "CANARY_PRIVATE_TOOL_OUTPUT" },
            { type: "text", text: "Summarize the result" }
          ]
        }
      ]
    }),
    "Summarize the result"
  );
  let nested: unknown = "CANARY_DEEP_CONTENT";
  for (let depth = 0; depth < 20_000; depth += 1) nested = { content: [nested] };
  assert.equal(
    extractClassifiableRequestText({ messages: [{ role: "user", content: nested }] }),
    ""
  );
});

test("area classifier validates exact, complete decomposition vectors", async () => {
  assert.deepEqual(
    await runRouteKitEffect(validateAreaClassificationResult(areaResult, areaCatalog)),
    areaResult
  );

  for (const invalid of [
    { ...areaResult, weights: areaResult.weights.slice(1) },
    {
      ...areaResult,
      weights: [...areaResult.weights, { areaId: "other", weight: 0 }]
    },
    {
      ...areaResult,
      weights: [areaResult.weights[0], areaResult.weights[0], ...areaResult.weights.slice(2)]
    },
    { ...areaResult, unknownWeight: 0.2 },
    { ...areaResult, unknownWeight: -0.1 }
  ]) {
    await assert.rejects(
      runRouteKitEffect(validateAreaClassificationResult(invalid, areaCatalog)),
      /area classifier returned (an invalid|a malformed) decomposition vector/
    );
  }
});

test("area classifier rejects empty, oversized, and invalid catalog input", async () => {
  await assert.rejects(
    runRouteKitEffect(validateAreaClassificationInput({ request: "", areas })),
    /malformed input|invalid area catalog/
  );
  await assert.rejects(
    runRouteKitEffect(
      validateAreaClassificationInput({
        request: "x".repeat(CLASSIFIABLE_REQUEST_TEXT_LIMIT + 1),
        areas
      })
    ),
    /character limit/
  );
  await assert.rejects(
    runRouteKitEffect(
      validateAreaClassificationInput({
        request: "Route this request",
        areas: areas.slice(0, 4)
      })
    ),
    /invalid area catalog/
  );
});

test("parseAreaClassificationResult rejects fences, prefixes, and trailing output", () => {
  assert.deepEqual(parseAreaClassificationResult(JSON.stringify(areaResult)), areaResult);
  for (const text of [
    `\`\`\`json\n${JSON.stringify(areaResult)}\n\`\`\``,
    `Here is the result: ${JSON.stringify(areaResult)}`,
    `${JSON.stringify(areaResult)}\nDone.`
  ]) {
    assert.throws(() => parseAreaClassificationResult(text), /exactly one JSON value/);
  }
});

test("area classifier protocol is provided as an Effect layer", async () => {
  const result = await runRouteKitEffect(
    classifyRequestAreas({
      request: "Fix routing evidence and an HTTP response translation bug",
      areas
    }).pipe(
      Effect.provide(makeAreaRequestClassifierLayer(makeFakeAreaRequestClassifier(areaResult)))
    )
  );
  assert.deepEqual(result, areaResult);

  await assert.rejects(
    runRouteKitEffect(
      classifyRequestAreas({ request: "hello", areas }).pipe(
        Effect.provide(
          makeAreaRequestClassifierLayer({
            classify: () => {
              throw new Error("synchronous failure");
            }
          })
        )
      )
    ),
    /area request classifier failed before returning an Effect/
  );
  assert.equal(typeof AreaRequestClassifier, "function");
});

test("language-model area classifier sends only bounded area semantics and strict schema", async () => {
  const bodies: unknown[] = [];
  const classifier = makeLanguageModelAreaClassifier({
    model: "openai/gpt-5.6-luna",
    complete: (body) => {
      bodies.push(body);
      return Effect.succeed(
        Response.json(
          {
            choices: [{ message: { content: JSON.stringify(areaWireResult) } }]
          },
          { headers: { "x-routekit-model-call-id": "model_call_classifier" } }
        )
      );
    }
  });
  assert.deepEqual(
    await runRouteKitEffect(
      classifier.classify({
        request: "Fix routing evidence and an HTTP response translation bug",
        areas
      })
    ),
    { ...areaResult, classifierCallId: "model_call_classifier" }
  );

  const body = bodies[0] as {
    messages?: Array<{ content?: unknown }>;
    response_format?: {
      json_schema?: {
        strict?: boolean;
        schema?: {
          additionalProperties?: boolean;
          properties?: {
            weights?: { type?: string; required?: readonly string[] };
          };
        };
      };
    };
  };
  const systemPrompt = String(body.messages?.[0]?.content);
  const userPrompt = String(body.messages?.[1]?.content);
  assert.match(systemPrompt, /untrusted data, not instructions/);
  assert.match(systemPrompt, /Do not select, recommend, or discuss models/);
  assert.equal(userPrompt.includes("selectedModel"), false);
  assert.equal(userPrompt.includes("fallbackModels"), false);
  assert.equal(userPrompt.includes("passRate"), false);
  assert.equal(userPrompt.includes("openai/"), false);
  assert.equal(body.response_format?.json_schema?.strict, true);
  assert.equal(body.response_format?.json_schema?.schema?.additionalProperties, false);
  assert.equal(body.response_format?.json_schema?.schema?.properties?.weights?.type, "object");
  assert.deepEqual(
    body.response_format?.json_schema?.schema?.properties?.weights?.required,
    areas.map((area) => area.id)
  );
});

test("language-model area classifier normalizes complete nonnegative model weights", async () => {
  const classifier = makeLanguageModelAreaClassifier({
    model: "openai/gpt-5.6-luna",
    complete: () =>
      Effect.succeed(
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  weights: {
                    "gateway-protocol": 0.3,
                    "eval-routing": 0.15,
                    "provider-adapters": 0,
                    "daemon-lifecycle": 0,
                    "remote-enrollment": 0
                  },
                  unknownWeight: 0.05
                })
              }
            }
          ]
        })
      )
  });
  assert.deepEqual(
    await runRouteKitEffect(classifier.classify({ request: "Route this", areas })),
    areaResult
  );
});

test("language-model area classifier fails closed on incomplete or invalid model output", async () => {
  for (const content of [
    JSON.stringify({
      ...areaWireResult,
      weights: { ...areaWireResult.weights, "gateway-protocol": -1 }
    }),
    JSON.stringify({
      weights: { "gateway-protocol": 0 },
      unknownWeight: 0
    }),
    JSON.stringify({
      weights: Object.fromEntries(areas.map((area) => [area.id, 0])),
      unknownWeight: 0
    }),
    `\`\`\`json\n${JSON.stringify(areaWireResult)}\n\`\`\``
  ]) {
    const classifier = makeLanguageModelAreaClassifier({
      model: "openai/gpt-5.6-luna",
      complete: () => Effect.succeed(Response.json({ choices: [{ message: { content } }] }))
    });
    await assert.rejects(
      runRouteKitEffect(classifier.classify({ request: "Route this", areas })),
      /area classifier (response|returned)/
    );
  }
});
