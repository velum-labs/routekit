import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-config";
import type { DiscoveredModel, ProviderSource } from "@velum-labs/routekit-gateway";
import { RoutingPolicyReadError, type RoutingPolicyReader } from "@velum-labs/routekit-gateway";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { startRouter } from "../index.js";

const ROUTING_PROFILE_HEADER = "x-routekit-profile";
const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";
const SNAPSHOT_FILE = "published-routing.v1.json";

type SnapshotProfile = {
  selectedModel: string;
  fallbackModels: string[];
  objective: "lowest-cost" | "lowest-latency" | "highest-quality";
  suiteDigest: string;
  evidenceDigest: string;
  publishedAt: string;
};

type Snapshot = {
  version: 1;
  generatedAt: string;
  profiles: Record<string, SnapshotProfile>;
};

function writeSnapshot(root: string, profile: SnapshotProfile): void {
  const snapshot: Snapshot = {
    version: 1,
    generatedAt: profile.publishedAt,
    profiles: { support: profile }
  };
  writeFileSync(join(root, SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o600
  });
}

function filePolicyReader(root: string): RoutingPolicyReader {
  return {
    getProfile: (profileId) =>
      Effect.try({
        try: () => {
          const snapshot = JSON.parse(readFileSync(join(root, SNAPSHOT_FILE), "utf8")) as Snapshot;
          return snapshot.profiles[profileId];
        },
        catch: (cause) =>
          new RoutingPolicyReadError({
            profileId,
            message: `failed to read routing profile: ${profileId}`,
            cause
          })
      })
  };
}

function providerSource(
  models: readonly DiscoveredModel[],
  requestedModels: string[]
): ProviderSource {
  return {
    sourceId: "openai",
    discovery: { discoverModels: () => Effect.succeed(models) },
    requests: {
      chat: (body) => {
        const model =
          typeof body === "object" &&
          body !== null &&
          "model" in body &&
          typeof body.model === "string"
            ? body.model
            : undefined;
        if (model !== undefined) requestedModels.push(model);
        return Effect.succeed(
          Response.json({
            id: "chatcmpl_snapshot",
            object: "chat.completion",
            created: 0,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: model },
                finish_reason: "stop"
              }
            ]
          })
        );
      },
      embeddings: () => Effect.succeed(Response.json({ data: [] }))
    },
    responses: { kind: "unsupported" },
    capabilities: {
      forModel: () => ({}),
      reasoningForModel: () => undefined
    },
    resource: { kind: "borrowed" }
  };
}

async function chat(
  url: string,
  model: string,
  headers: Readonly<Record<string, string>> = {}
): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Route this request" }]
    })
  });
}

test("published snapshots drive model auto selection without affecting explicit or eval traffic", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-snapshot-e2e-"));
  const requestedModels: string[] = [];
  const publishedAt = "2026-08-15T00:00:00.000Z";
  writeSnapshot(root, {
    selectedModel: "openai/winner",
    fallbackModels: ["openai/fallback"],
    objective: "lowest-cost",
    suiteDigest: "suite-v1",
    evidenceDigest: "evidence-v1",
    publishedAt
  });

  const running = await startRouter({
    config: parseRouterConfig({
      providers: { openai: {} },
      defaultModel: "openai/explicit"
    }),
    host: "127.0.0.1",
    port: 0,
    env: {},
    sources: {
      openai: providerSource(
        [{ id: "winner" }, { id: "fallback" }, { id: "explicit" }],
        requestedModels
      )
    },
    policyReader: filePolicyReader(root)
  });

  try {
    const winner = await chat(running.url, "auto", {
      [ROUTING_PROFILE_HEADER]: "support"
    });
    assert.equal(winner.status, 200);
    assert.equal(requestedModels.at(-1), "winner");

    // A newly published snapshot is observed without restarting the router. If
    // its selected model is absent from the live catalog, the ranked fallback
    // is used instead.
    writeSnapshot(root, {
      selectedModel: "openai/no-longer-served",
      fallbackModels: ["openai/fallback", "openai/winner"],
      objective: "lowest-cost",
      suiteDigest: "suite-v2",
      evidenceDigest: "evidence-v2",
      publishedAt
    });
    const fallback = await chat(running.url, "auto", {
      [ROUTING_PROFILE_HEADER]: "support"
    });
    assert.equal(fallback.status, 200);
    assert.equal(requestedModels.at(-1), "fallback");

    const explicit = await chat(running.url, "openai/explicit", {
      [ROUTING_PROFILE_HEADER]: "support"
    });
    assert.equal(explicit.status, 200);
    assert.equal(requestedModels.at(-1), "explicit");

    const callCount = requestedModels.length;
    const recursiveEval = await chat(running.url, "auto", {
      [ROUTING_PROFILE_HEADER]: "support",
      [EVAL_POLICY_BYPASS_HEADER]: "1"
    });
    assert.equal(recursiveEval.status, 400);
    assert.match(await recursiveEval.text(), /explicit provider\/model/);
    assert.equal(requestedModels.length, callCount, "rejected eval traffic never reaches a model");
  } finally {
    await runRouteKitEffect(running.close);
    rmSync(root, { recursive: true, force: true });
  }
});
