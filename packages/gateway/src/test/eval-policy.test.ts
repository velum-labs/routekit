import assert from "node:assert/strict";
import test from "node:test";

import {
  EVAL_POLICY_BYPASS_HEADER,
  type PublishedRoutingProfile,
  ROUTEKIT_ROUTING_PROFILE_HEADER
} from "@velum-labs/routekit-eval-contracts";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import {
  AutoRoutingUnavailableError,
  MissingRoutingProfileError,
  type RoutingPolicyReader,
  resolveAutoRoutingModel,
  UnknownRoutingProfileError
} from "../eval-policy.js";

const profile: PublishedRoutingProfile = {
  selectedModel: "openai/preferred",
  fallbackModels: ["openai/fallback", "openai/last"],
  objective: "lowest-cost",
  suiteDigest: "suite",
  evidenceDigest: "evidence",
  publishedAt: "2026-08-15T00:00:00.000Z"
};

function reader(profiles: Readonly<Record<string, PublishedRoutingProfile>>): RoutingPolicyReader {
  return {
    getProfile: (profileId) => Effect.succeed(profiles[profileId])
  };
}

test("auto routing uses the first served model in published rank order", async () => {
  const resolved = await runRouteKitEffect(
    resolveAutoRoutingModel({
      headers: { [ROUTEKIT_ROUTING_PROFILE_HEADER]: "support" },
      model: "auto",
      policyReader: reader({ support: profile }),
      servesModel: (model) => model === "openai/fallback" || model === "openai/last"
    })
  );
  assert.equal(resolved, "openai/fallback");
});

test("explicit models are unchanged without consulting the policy reader", async () => {
  let reads = 0;
  const profiles = new Map<string, PublishedRoutingProfile>();
  const resolved = await runRouteKitEffect(
    resolveAutoRoutingModel({
      headers: { [ROUTEKIT_ROUTING_PROFILE_HEADER]: "ignored" },
      model: "openai/explicit",
      policyReader: {
        getProfile: () => {
          reads += 1;
          return Effect.succeed(profiles.get("ignored"));
        }
      },
      servesModel: () => false
    })
  );
  assert.equal(resolved, "openai/explicit");
  assert.equal(reads, 0);
});

test("auto routing reports missing, unknown, unavailable, and bypass failures", async () => {
  await assert.rejects(
    runRouteKitEffect(
      resolveAutoRoutingModel({
        headers: {},
        model: "auto",
        policyReader: reader({}),
        servesModel: () => true
      })
    ),
    MissingRoutingProfileError
  );
  await assert.rejects(
    runRouteKitEffect(
      resolveAutoRoutingModel({
        headers: { [ROUTEKIT_ROUTING_PROFILE_HEADER]: "missing" },
        model: "auto",
        policyReader: reader({}),
        servesModel: () => true
      })
    ),
    (error: unknown) => error instanceof UnknownRoutingProfileError && error.profileId === "missing"
  );
  await assert.rejects(
    runRouteKitEffect(
      resolveAutoRoutingModel({
        headers: { [ROUTEKIT_ROUTING_PROFILE_HEADER]: "support" },
        model: "auto",
        policyReader: reader({ support: profile }),
        servesModel: () => false
      })
    ),
    (error: unknown) =>
      error instanceof AutoRoutingUnavailableError && error.profileId === "support"
  );
  await assert.rejects(
    runRouteKitEffect(
      resolveAutoRoutingModel({
        headers: {
          [EVAL_POLICY_BYPASS_HEADER]: "1",
          [ROUTEKIT_ROUTING_PROFILE_HEADER]: "support"
        },
        model: "auto",
        policyReader: reader({ support: profile }),
        servesModel: () => true
      })
    ),
    /explicit provider\/model/
  );
});
