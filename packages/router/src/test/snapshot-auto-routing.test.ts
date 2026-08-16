import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-config";
import type {
  DiscoveredModel,
  ProviderSource,
  RequestClassifierService
} from "@velum-labs/routekit-gateway";
import { RoutingPolicyReadError, type RoutingPolicyReader } from "@velum-labs/routekit-gateway";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { startRouter } from "../index.js";

const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";
const SNAPSHOT_FILE = "published-routing.v1.json";

const requestClassifier = (
  classify: (request: string) => Readonly<Record<string, number>>
): RequestClassifierService => ({
  classify: (input) => {
    const scores = classify(input.request);
    return Effect.succeed({
      scores: input.profiles.map((profile) => ({
        profileId: profile.id,
        probability: scores[profile.id] ?? 0
      }))
    });
  }
});

type SnapshotProfile = {
  selectedModel: string;
  fallbackModels: string[];
  objective: "lowest-cost" | "lowest-latency" | "highest-quality";
  suiteDigest: string;
  evidenceDigest: string;
  publishedAt: string;
  description?: string;
};

type Snapshot = {
  version: 1;
  generatedAt: string;
  profiles: Record<string, SnapshotProfile>;
};

function writeSnapshot(root: string, profiles: Record<string, SnapshotProfile>): void {
  const generatedAt = Object.values(profiles)[0]?.publishedAt ?? "2026-08-15T00:00:00.000Z";
  const snapshot: Snapshot = {
    version: 1,
    generatedAt,
    profiles
  };
  writeFileSync(join(root, SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o600
  });
}

function filePolicyReader(root: string): RoutingPolicyReader {
  const read = (): Record<string, SnapshotProfile> => {
    const snapshot = JSON.parse(readFileSync(join(root, SNAPSHOT_FILE), "utf8")) as Snapshot;
    return snapshot.profiles;
  };
  return {
    listProfiles: () =>
      Effect.try({
        try: read,
        catch: (cause) =>
          new RoutingPolicyReadError({
            profileId: "*",
            message: "failed to read published routing profiles",
            cause
          })
      }),
    getProfile: (profileId) =>
      Effect.try({
        try: () => read()[profileId],
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
  content: string,
  headers: Readonly<Record<string, string>> = {}
): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }]
    })
  });
}

async function responses(
  url: string,
  content: string,
  previousResponseId?: string
): Promise<Response> {
  return fetch(`${url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      input: [{ role: "user", content: [{ type: "input_text", text: content }] }],
      ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId })
    })
  });
}

async function anthropic(url: string, content: string): Promise<Response> {
  return fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "auto",
      max_tokens: 128,
      messages: [{ role: "user", content }]
    })
  });
}

test("published snapshots drive classified model auto selection without affecting explicit or eval traffic", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-snapshot-e2e-"));
  const requestedModels: string[] = [];
  const publishedAt = "2026-08-15T00:00:00.000Z";
  writeSnapshot(root, {
    react: {
      selectedModel: "openai/winner",
      fallbackModels: ["openai/fallback"],
      objective: "lowest-cost",
      suiteDigest: "suite-v1",
      evidenceDigest: "evidence-v1",
      publishedAt,
      description: "Frontend React work"
    },
    backend: {
      selectedModel: "openai/fallback",
      fallbackModels: ["openai/winner"],
      objective: "lowest-cost",
      suiteDigest: "suite-v1",
      evidenceDigest: "evidence-v1",
      publishedAt,
      description: "API and server work"
    }
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
    policyReader: filePolicyReader(root),
    classifier: requestClassifier((request) =>
      request.toLowerCase().includes("react")
        ? { react: 0.8, backend: 0.2 }
        : { react: 0.2, backend: 0.8 }
    )
  });

  try {
    const winner = await chat(running.url, "auto", "Fix the React useEffect loop");
    assert.equal(winner.status, 200);
    assert.equal(requestedModels.at(-1), "winner");

    const backend = await chat(running.url, "auto", "Add a Postgres index");
    assert.equal(backend.status, 200);
    assert.equal(requestedModels.at(-1), "fallback");

    const responsesResult = await responses(running.url, "Fix the React component");
    assert.equal(responsesResult.status, 200);
    assert.equal(requestedModels.at(-1), "winner");
    const statefulAuto = await responses(running.url, "continue", "resp_previous");
    assert.equal(statefulAuto.status, 400);
    assert.match(
      await statefulAuto.text(),
      /cannot safely route a stateful Responses continuation/
    );

    const anthropicResult = await anthropic(running.url, "Design a backend API");
    assert.equal(anthropicResult.status, 200);
    assert.equal(requestedModels.at(-1), "fallback");

    writeSnapshot(root, {
      react: {
        selectedModel: "openai/no-longer-served",
        fallbackModels: ["openai/fallback", "openai/winner"],
        objective: "lowest-cost",
        suiteDigest: "suite-v2",
        evidenceDigest: "evidence-v2",
        publishedAt,
        description: "Frontend React work"
      },
      backend: {
        selectedModel: "openai/fallback",
        fallbackModels: ["openai/winner"],
        objective: "lowest-cost",
        suiteDigest: "suite-v2",
        evidenceDigest: "evidence-v2",
        publishedAt,
        description: "API and server work"
      }
    });
    const fallback = await chat(running.url, "auto", "Fix the React useEffect loop");
    assert.equal(fallback.status, 200);
    assert.equal(requestedModels.at(-1), "fallback");

    const explicit = await chat(running.url, "openai/explicit", "Fix the React useEffect loop");
    assert.equal(explicit.status, 200);
    assert.equal(requestedModels.at(-1), "explicit");

    const callCount = requestedModels.length;
    const recursiveEval = await chat(running.url, "auto", "Fix the React useEffect loop", {
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
