import assert from "node:assert/strict";

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";

import { createServer, request as httpRequest } from "node:http";

import type { AddressInfo } from "node:net";

import { tmpdir } from "node:os";

import { dirname, join } from "node:path";

import test from "node:test";

import { CLIPROXY_PINNED_VERSION } from "@velum-labs/routekit-accounts";

import { RouteKitControlClient } from "@velum-labs/routekit-control";

import {
  ControlClient,
  ControlError,
  createServiceRecordStore
} from "@velum-labs/routekit-runtime";
import {
  runRouteKitEffect,
  runRouteKitEffectExit,
  throwRouteKitExit
} from "@velum-labs/routekit-runtime/effect";
import { parse as parseYaml } from "yaml";
import { prepareAccountTransaction } from "../account-transaction.js";
import { startRouteKitDaemon } from "../index.js";
import type { TelemetryTransportPayload } from "../telemetry.js";
import {
  assertInterruptedNativeActivationRecovery,
  freePort,
  mockProvider,
  nativeCredential,
  processAlive,
  waitFor,
  withMockAnthropicDiscovery,
  withMockNativeDiscovery
} from "./daemon-fixtures.js";

test("this-checkout daemon routes model auto from the published eval snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-eval-auto-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  const selectedModel = "openai/mock-model";
  writeFileSync(configPath, `providers:\n  openai: {}\ndefaultModel: ${selectedModel}\n`);
  mkdirSync(join(stateHome, "eval"), { recursive: true });
  writeFileSync(
    join(stateHome, "eval", "published-routing.v1.json"),
    `${JSON.stringify(
      {
        version: 1,
        generatedAt: "2026-08-15T00:00:00.000Z",
        profiles: {
          support: {
            selectedModel,
            fallbackModels: [],
            objective: "highest-quality",
            suiteDigest: "suite",
            evidenceDigest: "evidence",
            publishedAt: "2026-08-15T00:00:00.000Z"
          }
        }
      },
      null,
      2
    )}\n`
  );
  const upstream = await mockProvider([
    {
      id: "mock-model",
      object: "model",
      capabilities: { streaming: "supported", tools: "degraded" },
      supported_reasoning_levels: ["high"]
    },
    {
      id: "gpt-5.6-luna",
      object: "model",
      capabilities: { streaming: "supported", tools: "supported" }
    }
  ]);
  const daemon = await startRouteKitDaemon({
    packageVersion: "1.2.3",
    stateHome,
    configPath,
    port: 0,
    portless: false,
    env: {
      HOME: root,
      ROUTEKIT_HOME: stateHome,
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: upstream.url,
      ROUTEKIT_PORTLESS: "0"
    }
  });
  const dataToken = readFileSync(daemon.record.authTokenFile!, "utf8").trim();
  const chat = (headers: Readonly<Record<string, string>> = {}) =>
    fetch(`${daemon.dataUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${dataToken}`,
        "content-type": "application/json",
        ...headers
      },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Route this request" }]
      })
    });

  try {
    const routed = await chat();
    assert.equal(routed.status, 200);
    // The mock advertises the published winner plus the classifier model. A
    // 200 proves that `auto` classified onto that explicit model; forwarding
    // the literal `auto` would be rejected as absent from the live catalog.
    assert.match(await routed.text(), /daemon answer/);

    const evalTraffic = await chat({
      "x-routekit-eval-policy-bypass": "1"
    });
    assert.equal(evalTraffic.status, 400);
    assert.match(await evalTraffic.text(), /explicit provider\/model/);
  } finally {
    await daemon.close();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("singleton daemon exposes authenticated control and a stable reloadable data plane", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  writeFileSync(configPath, "providers:\n  openai: {}\ndefaultModel: openai/mock-model\n");
  const upstream = await mockProvider();
  const daemon = await startRouteKitDaemon({
    packageVersion: "1.2.3",
    stateHome,
    configPath,
    port: 0,
    portless: false,
    drainGraceMs: 2_000,
    env: {
      ...process.env,
      HOME: root,
      ROUTEKIT_HOME: stateHome,
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: upstream.url,
      ROUTEKIT_PORTLESS: "0"
    }
  });
  try {
    const record = createServiceRecordStore({
      home: stateHome,
      product: "routekit"
    }).read("daemon");
    assert.ok(record !== undefined);
    assert.equal(record.pid, process.pid);
    assert.equal(record.dataUrl, daemon.dataUrl);
    assert.equal(record.protocolVersion, "control.v2");
    assert.equal(record.generation, 1);
    assert.equal(statSync(join(stateHome, "services", "daemon.json")).mode & 0o777, 0o600);
    assert.ok(record.authTokenFile !== undefined);
    const dataToken = readFileSync(record.authTokenFile, "utf8").trim();
    assert.equal((await fetch(`${daemon.dataUrl}/v1/models`)).status, 401);

    await assert.rejects(
      runRouteKitEffect(new ControlClient({ url: record.url, token: "wrong" }).health())
    );
    const client = new RouteKitControlClient({
      url: record.url,
      token: record.controlToken!
    });
    const status = await runRouteKitEffect(client.call("daemon.status", {}));
    assert.equal(status.packageVersion, "1.2.3");
    assert.equal(status.dataUrl, daemon.dataUrl);
    const models = await runRouteKitEffect(client.call("models.list", {}));
    assert.deepEqual(
      models.models.map((model) => model.id),
      ["openai/mock-model"]
    );
    const modelInfo = await runRouteKitEffect(
      client.call("models.info", { model: "openai/mock-model" })
    );
    assert.equal(modelInfo.id, "openai/mock-model");
    assert.equal(modelInfo.provider, "openai");
    assert.equal(modelInfo.nativeModel, "mock-model");
    assert.equal(modelInfo.accountClass, "api-key");
    assert.equal(modelInfo.billingMode, "metered-api");
    assert.equal(modelInfo.default, true);
    assert.deepEqual(modelInfo.capabilities, {
      streaming: "supported",
      tools: "degraded"
    });
    assert.deepEqual(modelInfo.reasoning?.efforts, [{ id: "high" }]);
    assert.doesNotMatch(JSON.stringify(modelInfo), /test-key/);
    await assert.rejects(
      runRouteKitEffect(client.call("models.info", { model: "openai/not-real" })),
      (error: unknown) =>
        error instanceof ControlError &&
        error.code === "not_found" &&
        /unknown model/.test(error.message)
    );
    await assert.rejects(
      runRouteKitEffect(client.call("accounts.resetCredits", { kind: "codex", label: "work" })),
      (error: unknown) =>
        error instanceof ControlError &&
        error.code === "not_found" &&
        /no codex account pool/.test(error.message)
    );

    const beforeUrl = status.dataUrl;
    const snapshot = await runRouteKitEffect(client.call("config.get", {}));
    await assert.rejects(
      runRouteKitEffect(
        client.call("config.update", {
          expectedRevision: snapshot.revision,
          document: "providers:\n  openai:\n    apiKey: must-not-enter-daemon-state\n"
        })
      ),
      /inline credential/
    );
    const updated = await runRouteKitEffect(
      client.call(
        "config.update",
        {
          expectedRevision: snapshot.revision,
          document: "providers:\n  openai:\n    strategy: sticky\ndefaultModel: openai/mock-model\n"
        },
        { idempotencyKey: "config-one" }
      )
    );
    assert.equal(updated.revision, snapshot.revision + 1);
    assert.equal((await runRouteKitEffect(client.call("daemon.status", {}))).dataUrl, beforeUrl);
    assert.equal((await fetch(`${beforeUrl}/health`)).status, 200);

    const inflight = new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const request = httpRequest(
        `${beforeUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${dataToken}`,
            "x-test-slow": "1"
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8")
            })
          );
        }
      );
      request.once("error", reject);
      request.end(
        JSON.stringify({
          model: "openai/mock-model",
          messages: [{ role: "user", content: "finish during reload" }]
        })
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const reloaded = runRouteKitEffectExit(
      client.call("config.update", {
        expectedRevision: updated.revision,
        document:
          "providers:\n  openai:\n    strategy: round_robin\ndefaultModel: openai/mock-model\n"
      })
    );
    const response = await inflight;
    assert.equal(response.status, 200);
    const callIdHeader = response.headers["x-routekit-model-call-id"];
    assert.equal(typeof callIdHeader, "string");
    const callId = callIdHeader as string;
    assert.match(response.body, /daemon answer/);
    const afterInflight = throwRouteKitExit(await reloaded);
    assert.equal(afterInflight.revision, updated.revision + 1);
    const inspection = await runRouteKitEffect(client.call("calls.inspect", { callId }));
    assert.equal(inspection.callId, callId);
    assert.equal(inspection.effectiveModel, "openai/mock-model");
    assert.equal(inspection.nativeModel, "mock-model");
    assert.equal(inspection.provider, "openai");
    assert.equal(inspection.billingMode, "api_key");
    assert.deepEqual(inspection.retries, {
      attempts: 1,
      total: 0,
      accountFailovers: 0
    });
    assert.equal(inspection.cost.unknownUsage, true);
    assert.equal(inspection.cost.unknownCost, true);
    assert.equal("account" in inspection, false);
    const rejected = await fetch(`${beforeUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${dataToken}`
      },
      body: JSON.stringify({
        model: "openai/missing-model",
        messages: [{ role: "user", content: "reject this" }]
      })
    });
    assert.equal(rejected.status, 400);
    const rejectedCallId = rejected.headers.get("x-routekit-model-call-id");
    assert.ok(rejectedCallId);
    await rejected.text();
    const rejectedInspection = await runRouteKitEffect(
      client.call("calls.inspect", {
        callId: rejectedCallId
      })
    );
    assert.equal(rejectedInspection.status, "failed");
    assert.equal(rejectedInspection.effectiveModel, "openai/missing-model");
    assert.equal(rejectedInspection.provider, "openai");
    assert.equal(rejectedInspection.error?.kind, "validation_error");
    const embedding = await fetch(`${beforeUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${dataToken}`
      },
      body: JSON.stringify({
        model: "openai/mock-model",
        input: "embed this"
      })
    });
    assert.equal(embedding.status, 200);
    const embeddingCallId = embedding.headers.get("x-routekit-model-call-id");
    assert.ok(embeddingCallId);
    await embedding.text();
    const embeddingInspection = await runRouteKitEffect(
      client.call("calls.inspect", {
        callId: embeddingCallId
      })
    );
    assert.equal(embeddingInspection.effectiveModel, "openai/mock-model");
    assert.equal(embeddingInspection.nativeModel, "mock-model");
    assert.equal(embeddingInspection.provider, "openai");
    assert.equal(embeddingInspection.billingMode, "api_key");
    await assert.rejects(
      runRouteKitEffect(client.call("calls.inspect", { callId: "model_call_missing" })),
      (error: unknown) => error instanceof ControlError && error.code === "not_found"
    );
    const leaderboard = await runRouteKitEffect(
      client.call("calls.leaderboard", {
        by: "provider",
        sort: "requests",
        limit: 5,
        window: "live"
      })
    );
    assert.equal(leaderboard.by, "provider");
    assert.equal(leaderboard.source, "live");
    assert.ok(leaderboard.sampleSize >= 1);
    assert.ok(leaderboard.rows.some((row) => row.key === "openai"));
    await assert.rejects(
      runRouteKitEffect(client.call("calls.leaderboard", { window: "24h" })),
      (error: unknown) =>
        error instanceof ControlError &&
        error.code === "bad_request" &&
        /durable leaderboard rollups are disabled/.test(error.message)
    );

    await assert.rejects(
      runRouteKitEffect(
        client.call("config.update", {
          expectedRevision: snapshot.revision,
          document: "providers: {}\n"
        })
      ),
      (error: unknown) => error instanceof ControlError && error.code === "conflict"
    );
    assert.equal(
      (await runRouteKitEffect(client.call("config.get", {}))).revision,
      afterInflight.revision
    );
    const concurrent = await Promise.allSettled([
      runRouteKitEffect(
        client.call("config.update", {
          expectedRevision: afterInflight.revision,
          document: "providers:\n  openai:\n    strategy: sticky\ndefaultModel: openai/mock-model\n"
        })
      ),
      runRouteKitEffect(
        client.call("config.update", {
          expectedRevision: afterInflight.revision,
          document:
            "providers:\n  openai:\n    strategy: capacity_weighted\ndefaultModel: openai/mock-model\n"
        })
      )
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      concurrent.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof ControlError &&
          result.reason.code === "conflict"
      ).length,
      1
    );
    assert.equal(
      (await runRouteKitEffect(client.call("config.get", {}))).revision,
      afterInflight.revision + 1
    );

    const enrolled = await runRouteKitEffect(
      client.call(
        "accounts.enroll",
        {
          kind: "codex",
          label: "work",
          credential: {
            tokens: {
              access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.",
              refresh_token: "must-not-be-returned",
              account_id: "acct-work"
            }
          }
        },
        { idempotencyKey: "enroll-work" }
      )
    );
    assert.equal(enrolled.enrolled, true);
    const accounts = await runRouteKitEffect(client.call("accounts.list", {}));
    assert.deepEqual(accounts.accounts, [
      { subscriptionKind: "codex", label: "work", connector: "native" }
    ]);
    assert.doesNotMatch(JSON.stringify(accounts), /must-not-be-returned/);
    const removed = await runRouteKitEffect(
      client.call(
        "accounts.remove",
        { kind: "codex", label: "work" },
        { idempotencyKey: "remove-work" }
      )
    );
    assert.equal(removed.removed, true);
    await assert.rejects(
      runRouteKitEffect(
        client.call(
          "accounts.remove",
          { kind: "github", label: "work" },
          { idempotencyKey: "remove-unknown" }
        )
      ),
      (error: unknown) =>
        error instanceof ControlError && /unknown subscription kind/.test(error.message)
    );
  } finally {
    await daemon.close();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("local Codex preparation ranks an incompatible OpenAI default by native recency", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-codex-ranking-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  writeFileSync(configPath, "providers:\n  openai: {}\ndefaultModel: openai/text-embedding-test\n");
  const upstream = await mockProvider([
    { id: "text-embedding-test", object: "model", created: 50 },
    { id: "older-generation", object: "model", created: 100 },
    { id: "newer-generation", object: "model", created: 200 }
  ]);
  const originalFetch = globalThis.fetch;
  let openRouterFetches = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "openrouter.ai") {
      openRouterFetches += 1;
      if (url.pathname === "/api/v1/models") {
        return Response.json({
          data: [
            {
              id: "openai/older-generation",
              created: 900,
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"]
              },
              supported_parameters: ["tools"]
            },
            {
              id: "openai/newer-generation",
              created: 800,
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"]
              },
              supported_parameters: ["tools"]
            }
          ]
        });
      }
      if (url.pathname === "/api/v1/embeddings/models") {
        return Response.json({ data: [{ id: "openai/text-embedding-test" }] });
      }
      return Response.json({ data: [] });
    }
    return await originalFetch(input, init);
  };

  let daemon: Awaited<ReturnType<typeof startRouteKitDaemon>> | undefined;
  try {
    daemon = await startRouteKitDaemon({
      packageVersion: "1.2.3",
      stateHome,
      configPath,
      port: 0,
      portless: false,
      env: {
        ...process.env,
        HOME: root,
        ROUTEKIT_HOME: stateHome,
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: upstream.url,
        ROUTEKIT_PORTLESS: "0"
      }
    });
    const client = new RouteKitControlClient({
      url: daemon.record.url,
      token: daemon.record.controlToken!
    });
    const explicit = await runRouteKitEffect(
      client.call("launcher.prepare", {
        tool: "codex",
        model: "openai/older-generation"
      })
    );
    assert.equal(explicit.model, "openai/older-generation");
    assert.equal(openRouterFetches, 0);

    const implicit = await runRouteKitEffect(client.call("launcher.prepare", { tool: "codex" }));
    assert.equal(implicit.model, "openai/newer-generation");
    assert.equal(openRouterFetches, 4);
    assert.equal(
      implicit.codexSelection?.models.find((model) => model.id === "openai/older-generation")
        ?.createdAt,
      100,
      "native OpenAI creation time wins over OpenRouter"
    );
    assert.equal(
      implicit.codexSelection?.models.find((model) => model.id === "openai/newer-generation")
        ?.createdAt,
      200
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (daemon !== undefined) await daemon.close();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon account activity persists last selection independently of leaderboard rollups", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-activity-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  const accountsDirectory = join(stateHome, "subscriptions", "codex");
  const activityPath = join(stateHome, "usage", "account-activity.v1.json");
  mkdirSync(accountsDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(join(stateHome, "usage"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(accountsDirectory, "work.json"),
    `${JSON.stringify(nativeCredential("codex"))}\n`,
    { mode: 0o600 }
  );
  writeFileSync(
    activityPath,
    `${JSON.stringify({
      version: 1,
      sequence: 3,
      accounts: [
        {
          identity: "codex:work",
          lastSelectedAt: 1_700_000_000_000,
          sequence: 3
        }
      ]
    })}\n`,
    { mode: 0o600 }
  );
  writeFileSync(
    configPath,
    [
      "providers:",
      "  codex: {}",
      "defaultModel: codex/gpt-test-model",
      "leaderboard:",
      "  durable: false",
      ""
    ].join("\n")
  );
  try {
    await withMockNativeDiscovery("codex", async () => {
      const daemon = await startRouteKitDaemon({
        packageVersion: "1.2.3",
        stateHome,
        configPath,
        port: 0,
        portless: false,
        env: {
          HOME: root,
          ROUTEKIT_HOME: stateHome,
          ROUTEKIT_PORTLESS: "0"
        }
      });
      try {
        const client = new RouteKitControlClient({
          url: daemon.record.url,
          token: daemon.record.controlToken!
        });
        const status = await runRouteKitEffect(client.call("accounts.status", {}));
        const usage = await runRouteKitEffect(client.call("accounts.usage", {}));
        assert.equal(status.accounts[0]?.lastSelected, true);
        assert.equal(status.accounts[0]?.lastSelected, true);
        assert.equal(status.accounts[0]?.serving, false);
        assert.equal(status.accounts[0]?.inFlight, 0);
        assert.equal(status.accounts[0]?.lastSelectedAt, 1_700_000_000_000);
        assert.equal(usage.accountSets[0]?.members[0]?.lastSelected, true);
        assert.equal(usage.accountSets[0]?.members[0]?.lastSelected, true);
        assert.equal(usage.accountSets[0]?.members[0]?.lastSelectedAt, 1_700_000_000_000);
        assert.equal(existsSync(join(stateHome, "usage", "leaderboard-rollups.v1.json")), false);

        await runRouteKitEffect(
          client.call(
            "accounts.rename",
            { kind: "codex", source: "work", target: "personal" },
            { idempotencyKey: "activity-rename" }
          )
        );
        const renamedStatus = await runRouteKitEffect(client.call("accounts.status", {}));
        assert.equal(renamedStatus.accounts[0]?.label, "personal");
        assert.equal(renamedStatus.accounts[0]?.lastSelected, true);
        assert.equal(renamedStatus.accounts[0]?.lastSelectedAt, 1_700_000_000_000);
        const persisted = JSON.parse(readFileSync(activityPath, "utf8")) as {
          accounts: Array<{ identity: string }>;
        };
        assert.deepEqual(
          persisted.accounts.map((account) => account.identity),
          ["codex:personal"]
        );

        const beforeReload = await runRouteKitEffect(client.call("daemon.status", {}));
        const reloaded = await runRouteKitEffect(
          client.call("config.update", {
            expectedRevision: (await runRouteKitEffect(client.call("config.get", {}))).revision,
            document: [
              "providers:",
              "  codex:",
              "    strategy: sticky",
              "defaultModel: codex/gpt-test-model",
              "leaderboard:",
              "  durable: false",
              ""
            ].join("\n")
          })
        );
        assert.ok(reloaded.revision > beforeReload.configRevision);
        const afterReload = await runRouteKitEffect(client.call("accounts.status", {}));
        assert.equal(afterReload.accounts[0]?.label, "personal");
        assert.equal(afterReload.accounts[0]?.lastSelected, true);
        assert.equal(afterReload.accounts[0]?.lastSelectedAt, 1_700_000_000_000);
        assert.equal(afterReload.accounts[0]?.serving, false);
        assert.equal(afterReload.accounts[0]?.inFlight, 0);
        await assert.rejects(
          runRouteKitEffect(client.call("calls.leaderboard", { window: "24h" })),
          (error: unknown) =>
            error instanceof ControlError &&
            error.code === "bad_request" &&
            /durable leaderboard rollups are disabled/.test(error.message)
        );

        const removed = await runRouteKitEffect(
          client.call(
            "accounts.remove",
            { kind: "codex", label: "personal" },
            { idempotencyKey: "activity-remove" }
          )
        );
        assert.equal(removed.removed, true);
        const afterRemove = JSON.parse(readFileSync(activityPath, "utf8")) as {
          accounts: Array<{ identity: string }>;
        };
        assert.deepEqual(afterRemove.accounts, []);
      } finally {
        await daemon.close();
      }

      writeFileSync(
        join(accountsDirectory, "personal.json"),
        `${JSON.stringify(nativeCredential("codex"))}\n`,
        { mode: 0o600 }
      );
      writeFileSync(
        activityPath,
        `${JSON.stringify({
          version: 1,
          sequence: 4,
          accounts: [
            {
              identity: "codex:personal",
              lastSelectedAt: 1_700_000_000_000,
              sequence: 4
            }
          ]
        })}\n`,
        { mode: 0o600 }
      );
      writeFileSync(
        configPath,
        [
          "providers:",
          "  codex: {}",
          "defaultModel: codex/gpt-test-model",
          "leaderboard:",
          "  durable: false",
          ""
        ].join("\n")
      );

      const restarted = await startRouteKitDaemon({
        packageVersion: "1.2.3",
        stateHome,
        configPath,
        port: 0,
        portless: false,
        env: {
          HOME: root,
          ROUTEKIT_HOME: stateHome,
          ROUTEKIT_PORTLESS: "0"
        }
      });
      try {
        const client = new RouteKitControlClient({
          url: restarted.record.url,
          token: restarted.record.controlToken!
        });
        const status = await runRouteKitEffect(client.call("accounts.status", {}));
        assert.equal(status.accounts[0]?.label, "personal");
        assert.equal(status.accounts[0]?.lastSelected, true);
        assert.equal(status.accounts[0]?.lastSelectedAt, 1_700_000_000_000);
        assert.equal(status.accounts[0]?.serving, false);
        assert.equal(status.accounts[0]?.inFlight, 0);
      } finally {
        await restarted.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleared persisted cooldown remains absent and eligible after daemon reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-cooldown-reload-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  const accountsDirectory = join(stateHome, "subscriptions", "codex");
  const statePath = join(accountsDirectory, ".state.json");
  const coolingUntil = Date.now() / 1000 + 3_600;
  mkdirSync(accountsDirectory, { recursive: true });
  writeFileSync(
    join(accountsDirectory, "work.json"),
    `${JSON.stringify(nativeCredential("codex"))}\n`
  );
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      members: [{ id: "work", coolingUntil, cooldownRevision: 1 }]
    })
  );
  writeFileSync(configPath, "providers:\n  codex: {}\ndefaultModel: codex/gpt-test-model\n");

  try {
    await withMockNativeDiscovery(
      "codex",
      async () => {
        const daemon = await startRouteKitDaemon({
          packageVersion: "1.2.3",
          stateHome,
          configPath,
          port: 0,
          portless: false,
          env: {
            HOME: root,
            ROUTEKIT_HOME: stateHome,
            ROUTEKIT_PORTLESS: "0"
          }
        });
        try {
          const client = new RouteKitControlClient({
            url: daemon.record.url,
            token: daemon.record.controlToken!
          });
          const prepared = await runRouteKitEffect(
            client.call("launcher.prepare", { tool: "codex" })
          );
          assert.equal(prepared.model, "codex/gpt-test-model");
          assert.deepEqual(prepared.codexSelection?.compatibleModelIds, ["codex/gpt-test-model"]);
          assert.deepEqual(prepared.codexSelection?.models[0]?.architecture?.outputModalities, [
            "text"
          ]);
          const before = await runRouteKitEffect(client.call("accounts.status", {}));
          assert.equal(before.accounts[0]?.relayOpen, false);
          assert.deepEqual(before.accounts[0]?.readinessReasons, [
            { code: "cooldown_active", until: coolingUntil }
          ]);

          const usage = await runRouteKitEffect(client.call("accounts.usage", {}));
          const recovered = usage.accountSets[0]?.members[0];
          assert.equal(recovered?.coolingUntil, undefined);
          assert.equal(recovered?.poolEligible, true);
          assert.equal(recovered?.relayReady, true);
          assert.deepEqual(recovered?.readinessReasons, []);

          const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
            members: Array<{ coolingUntil?: number; cooldownRevision?: number }>;
          };
          assert.equal(persisted.members[0]?.coolingUntil, undefined);
          assert.equal(persisted.members[0]?.cooldownRevision, 2);

          const daemonStatus = await runRouteKitEffect(client.call("daemon.status", {}));
          await runRouteKitEffect(
            client.call("daemon.reload", { expectedRevision: daemonStatus.configRevision })
          );
          const afterReload = await runRouteKitEffect(client.call("accounts.status", {}));
          assert.equal(afterReload.accounts[0]?.relayOpen, true);
          assert.deepEqual(afterReload.accounts[0]?.readinessReasons, []);
          const afterUsage = await runRouteKitEffect(client.call("accounts.usage", {}));
          assert.equal(afterUsage.accountSets[0]?.members[0]?.coolingUntil, undefined);
          assert.equal(afterUsage.accountSets[0]?.members[0]?.poolEligible, true);
          assert.equal(
            (
              JSON.parse(readFileSync(statePath, "utf8")) as {
                members: Array<{ coolingUntil?: number }>;
              }
            ).members[0]?.coolingUntil,
            undefined
          );
        } finally {
          await daemon.close();
        }
      },
      { healthyUsage: true }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
