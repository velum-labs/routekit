import assert from "node:assert/strict";
import test from "node:test";

import {
  EVAL_POLICY_BYPASS_HEADER,
  type PublishedRoutingProfile
} from "@velum-labs/routekit-eval-contracts";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import {
  AutoRoutingUnavailableError,
  RoutingPolicyReadError,
  resolveAutoRoutingModel,
  routingPolicyReaderFromMap
} from "../eval-policy.js";
import { makeFakeRequestClassifier } from "../request-classifier.js";

const react: PublishedRoutingProfile = {
  selectedModel: "openai/gpt-5.6-sol",
  fallbackModels: ["openai/gpt-5.6-terra"],
  objective: "lowest-cost",
  suiteDigest: "suite-react",
  evidenceDigest: "evidence-react",
  publishedAt: "2026-08-15T00:00:00.000Z",
  description: "Frontend React work"
};

const backend: PublishedRoutingProfile = {
  selectedModel: "openai/gpt-5.6-terra",
  fallbackModels: ["openai/last"],
  objective: "lowest-cost",
  suiteDigest: "suite-backend",
  evidenceDigest: "evidence-backend",
  publishedAt: "2026-08-15T00:00:00.000Z",
  description: "API and server work"
};

const reader = routingPolicyReaderFromMap({ react, backend });

test("auto routing classifies onto the react winner", async () => {
  const resolved = await runRouteKitEffect(
    resolveAutoRoutingModel({
      headers: {},
      model: "auto",
      requestText: "Fix the React useEffect loop",
      policyReader: reader,
      classifier: makeFakeRequestClassifier({ react: 0.8, backend: 0.2 }),
      servesModel: (model) =>
        model === "openai/gpt-5.6-sol" ||
        model === "openai/gpt-5.6-terra" ||
        model === "openai/last"
    })
  );
  assert.equal(resolved, "openai/gpt-5.6-sol");
});

test("auto routing classifies onto the backend fallback when the winner is absent", async () => {
  const resolved = await runRouteKitEffect(
    resolveAutoRoutingModel({
      headers: {},
      model: "auto",
      requestText: "Add a Postgres index",
      policyReader: reader,
      classifier: makeFakeRequestClassifier({ react: 0.1, backend: 0.9 }),
      servesModel: (model) => model === "openai/last"
    })
  );
  assert.equal(resolved, "openai/last");
});

test("explicit models are unchanged without consulting the classifier", async () => {
  let classified = 0;
  const resolved = await runRouteKitEffect(
    resolveAutoRoutingModel({
      headers: {},
      model: "openai/explicit",
      requestText: "ignored",
      policyReader: reader,
      classifier: {
        classify: () => {
          classified += 1;
          return makeFakeRequestClassifier({ react: 1 }).classify({
            request: "ignored",
            profiles: []
          });
        }
      },
      servesModel: () => false
    })
  );
  assert.equal(resolved, "openai/explicit");
  assert.equal(classified, 0);
});

test("auto routing reports unavailable and bypass failures", async () => {
  await assert.rejects(
    runRouteKitEffect(
      resolveAutoRoutingModel({
        headers: {},
        model: "auto",
        requestText: "hello",
        policyReader: routingPolicyReaderFromMap({}),
        classifier: makeFakeRequestClassifier({}),
        servesModel: () => true
      })
    ),
    (error: unknown) =>
      error instanceof AutoRoutingUnavailableError &&
      error.message.includes("no published routing profiles")
  );
  await assert.rejects(
    runRouteKitEffect(
      resolveAutoRoutingModel({
        headers: {},
        model: "auto",
        requestText: "hello",
        policyReader: reader,
        classifier: makeFakeRequestClassifier({ react: 1, backend: 0 }),
        servesModel: () => false
      })
    ),
    (error: unknown) => error instanceof AutoRoutingUnavailableError && error.profileId === "react"
  );
  await assert.rejects(
    runRouteKitEffect(
      resolveAutoRoutingModel({
        headers: { [EVAL_POLICY_BYPASS_HEADER]: "1" },
        model: "auto",
        requestText: "hello",
        policyReader: reader,
        classifier: makeFakeRequestClassifier({ react: 1 }),
        servesModel: () => true
      })
    ),
    /explicit provider\/model/
  );
});

test("auto routing maps snapshot and malformed classifier failures to unavailable", async () => {
  await assert.rejects(
    runRouteKitEffect(
      resolveAutoRoutingModel({
        headers: {},
        model: "auto",
        requestText: "hello",
        policyReader: {
          ...routingPolicyReaderFromMap({}),
          listProfiles: () =>
            Effect.fail(
              new RoutingPolicyReadError({
                profileId: "*",
                message: "corrupt snapshot"
              })
            )
        },
        classifier: makeFakeRequestClassifier({ react: 1, backend: 0 }),
        servesModel: () => true
      })
    ),
    (error: unknown) =>
      error instanceof AutoRoutingUnavailableError &&
      error.message === "failed to read published routing profiles"
  );
  await assert.rejects(
    runRouteKitEffect(
      resolveAutoRoutingModel({
        headers: {},
        model: "auto",
        requestText: "hello",
        policyReader: reader,
        classifier: {
          classify: () =>
            Effect.succeed({
              scores: [{ profileId: "unknown", probability: 1 }]
            })
        },
        servesModel: () => true
      })
    ),
    (error: unknown) =>
      error instanceof AutoRoutingUnavailableError && error.message.includes("unknown profile")
  );
  await assert.rejects(
    runRouteKitEffect(
      resolveAutoRoutingModel({
        headers: {},
        model: "auto",
        requestText: "hello",
        policyReader: reader,
        classifier: {
          classify: () => {
            throw new Error("synchronous classifier failure");
          }
        },
        servesModel: () => true
      })
    ),
    (error: unknown) =>
      error instanceof AutoRoutingUnavailableError &&
      error.message === "request classifier failed before returning an Effect"
  );
  await assert.rejects(
    runRouteKitEffect(
      resolveAutoRoutingModel({
        headers: {},
        model: "auto",
        requestText: "hello",
        policyReader: {
          ...routingPolicyReaderFromMap({}),
          listProfiles: () => {
            throw new Error("synchronous reader failure");
          }
        },
        classifier: makeFakeRequestClassifier({ react: 1, backend: 0 }),
        servesModel: () => true
      })
    ),
    (error: unknown) =>
      error instanceof AutoRoutingUnavailableError &&
      error.message === "failed to read published routing profiles"
  );
});
