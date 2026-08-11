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

import { createServer } from "node:http";

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

test("daemon owns the cliproxy sidecar: spawn, restart, account routing, shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-cliproxy-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  writeFileSync(configPath, "providers:\n  cliproxy: {}\ndefaultModel: cliproxy/g-model\n");
  const cliproxyDirectory = join(stateHome, "cliproxy");
  const authDirectory = join(cliproxyDirectory, "auth");
  const markerPath = join(root, "sidecar-pids.log");
  const port = await freePort();
  // Managed sidecar config: RouteKit-owned ingress key and listen port.
  mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(cliproxyDirectory, "config.yaml"),
    [
      'host: "127.0.0.1"',
      `port: ${port}`,
      `auth-dir: "${authDirectory}"`,
      "api-keys:",
      '  - "rk-test-ingress-key"',
      ""
    ].join("\n")
  );
  writeFileSync(
    join(authDirectory, "antigravity-user@example.com.json"),
    JSON.stringify({ type: "antigravity", access_token: "test-access" })
  );
  // Fake pinned binary: records its pid and serves /v1/models on the
  // configured port so discovery and reachability run against it.
  const binary = join(cliproxyDirectory, "bin", CLIPROXY_PINNED_VERSION, "cli-proxy-api");
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(
    binary,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const http = require("node:http");',
      'const cfg = fs.readFileSync(process.argv[process.argv.indexOf("--config") + 1], "utf8");',
      "const port = Number(/port:\\s*(\\d+)/.exec(cfg)[1]);",
      // Record the pid only after the listener is accepting so crash-recovery
      // waiters do not race the bind.
      "http.createServer((req, res) => {",
      '  res.setHeader("content-type", "application/json");',
      '  res.end(JSON.stringify({ data: [{ id: "g-model", object: "model" }] }));',
      '}).listen(port, "127.0.0.1", () => {',
      `  fs.appendFileSync(${JSON.stringify(markerPath)}, process.pid + "\\n");`,
      "});",
      ""
    ].join("\n")
  );
  chmodSync(binary, 0o755);
  let failActivation = false;
  const daemon = await startRouteKitDaemon({
    packageVersion: "1.2.3",
    stateHome,
    configPath,
    port: 0,
    portless: false,
    drainGraceMs: 2_000,
    onAccountTransactionPhase: (phase) => {
      if (failActivation && phase === "credentials-written") {
        throw new Error("injected activation failure");
      }
    },
    env: {
      ...process.env,
      HOME: root,
      ROUTEKIT_HOME: stateHome,
      ROUTEKIT_PORTLESS: "0",
      ROUTEKIT_CLIPROXY_API_KEY: undefined,
      ROUTEKIT_CLIPROXY_BASE_URL: undefined
    }
  });
  let firstPid = 0;
  try {
    const record = createServiceRecordStore({
      home: stateHome,
      product: "routekit"
    }).read("daemon");
    assert.ok(record?.controlToken !== undefined);
    const client = new RouteKitControlClient({
      url: record.url,
      token: record.controlToken
    });

    // The daemon spawned the sidecar and the router discovers through it
    // with the injected managed ingress key + base URL.
    const pids = readFileSync(markerPath, "utf8").trim().split("\n").map(Number);
    assert.equal(pids.length, 1);
    firstPid = pids[0]!;
    assert.ok(processAlive(firstPid));
    const models = await client.call("models.list", {});
    assert.deepEqual(
      models.models.map((model) => model.id),
      ["cliproxy/g-model"]
    );

    // One unified account surface: the cliproxy store shows up beside native
    // accounts with its connector and a live relay.
    const status = await client.call("accounts.status", {});
    assert.deepEqual(status.accounts, [
      {
        subscriptionKind: "gemini",
        label: "antigravity-user@example.com",
        connector: "cliproxy",
        localOnly: true,
        credentialValid: true,
        configured: true,
        relayOpen: true,
        serving: false,
        inFlight: 0,
        lastSelected: false,
        models: []
      }
    ]);

    // Crash recovery: kill the sidecar; the daemon respawns it.
    process.kill(firstPid, "SIGKILL");
    assert.ok(
      await waitFor(() => {
        const seen = readFileSync(markerPath, "utf8").trim().split("\n");
        return seen.length === 2;
      }, 10_000),
      "sidecar was not respawned after a crash"
    );
    // Wait until the respawned listener answers discovery before mutating.
    assert.ok(
      await waitFor(async () => {
        try {
          const listed = await client.call("models.list", {});
          return listed.models.some((model) => model.id === "cliproxy/g-model");
        } catch {
          return false;
        }
      }, 10_000),
      "respawned sidecar did not become discoverable"
    );
    const respawnedPid = Number(readFileSync(markerPath, "utf8").trim().split("\n")[1]);

    // accounts.sync rescans the store and restarts the managed sidecar so it
    // cannot miss an auth-directory watch event.
    writeFileSync(join(authDirectory, "broken-account.json"), "{not-json");
    writeFileSync(join(authDirectory, "kimi-invalid.json"), JSON.stringify({ type: "kimi" }));
    const synced = await client.call("accounts.sync", {}, { idempotencyKey: "sync-1" });
    assert.equal(synced.synced, true);
    assert.ok(
      await waitFor(() => readFileSync(markerPath, "utf8").trim().split("\n").length === 3, 10_000),
      "accounts.sync did not restart the managed sidecar"
    );
    assert.equal(processAlive(respawnedPid), false);
    const refreshedStatus = await client.call("accounts.status", {});
    assert.equal(
      refreshedStatus.accounts.find((entry) => entry.label === "antigravity-user@example.com")
        ?.credentialValid,
      true
    );
    assert.equal(
      refreshedStatus.accounts.find((entry) => entry.label === "kimi-invalid")?.credentialValid,
      false
    );
    assert.equal(
      refreshedStatus.accounts.find((entry) => entry.label === "broken-account")?.credentialValid,
      false
    );
    const syncedPid = Number(readFileSync(markerPath, "utf8").trim().split("\n")[2]);

    // Unclassified/corrupt auth files remain removable using the kind shown
    // by accounts.list rather than becoming stuck in the store.
    const unknownRemoved = await client.call(
      "accounts.remove",
      { kind: "broken", label: "broken-account" },
      { idempotencyKey: "remove-broken" }
    );
    assert.equal(unknownRemoved.removed, true);
    assert.equal(existsSync(join(authDirectory, "broken-account.json")), false);
    assert.ok(
      await waitFor(() => readFileSync(markerPath, "utf8").trim().split("\n").length === 4, 10_000),
      "accounts.remove did not restart the managed sidecar"
    );
    assert.equal(processAlive(syncedPid), false);

    // Legacy cliproxy aliases canonicalize and remove through the native kind.
    writeFileSync(
      join(authDirectory, "legacy-claude@example.com.json"),
      JSON.stringify({ type: "claude", access_token: "legacy-access" })
    );
    const orphanRemoved = await client.call(
      "accounts.remove",
      { kind: "claude-code", label: "legacy-claude@example.com" },
      { idempotencyKey: "remove-legacy-claude" }
    );
    assert.equal(orphanRemoved.removed, true);
    assert.equal(existsSync(join(authDirectory, "legacy-claude@example.com.json")), false);
    const beforeActivation = await client.call("daemon.status", {});
    failActivation = true;
    await assert.rejects(
      client.call(
        "accounts.enrollActivate",
        {
          kind: "kimi",
          accounts: [
            {
              label: "kimi-rollback",
              credential: {
                type: "kimi",
                access_token: "rollback-access",
                expiry: "2999-01-01T00:00:00Z"
              }
            }
          ]
        },
        { idempotencyKey: "activate-kimi-failure" }
      )
    );
    failActivation = false;
    assert.equal(existsSync(join(authDirectory, "kimi-rollback.json")), false);
    assert.equal(existsSync(join(stateHome, "account-transactions")), false);
    assert.equal(
      (await client.call("daemon.status", {})).configRevision,
      beforeActivation.configRevision
    );
    assert.equal(
      (await client.call("daemon.status", {})).accountRevision,
      beforeActivation.accountRevision
    );
    const activationParams = {
      kind: "grok",
      accounts: [
        {
          label: "xai-transaction@example.com",
          credential: {
            type: "xai",
            token: {
              access_token: "transaction-access",
              expires_at: Math.floor(Date.now() / 1_000) + 3_600
            }
          }
        }
      ]
    };
    const activated = await client.call("accounts.enrollActivate", activationParams, {
      idempotencyKey: "activate-grok"
    });
    assert.equal(activated.activated, true);
    assert.equal(activated.configRevision, beforeActivation.configRevision + 1);
    assert.equal(activated.accountRevision, beforeActivation.accountRevision + 1);
    assert.equal(existsSync(join(authDirectory, "xai-transaction@example.com.json")), true);
    assert.doesNotMatch(JSON.stringify(activated), /transaction-access/);
    assert.equal(existsSync(join(stateHome, "account-transactions")), false);

    // A fresh transport retry converges on the committed state without
    // incrementing either revision again.
    const replayed = await client.call("accounts.enrollActivate", activationParams, {
      idempotencyKey: "activate-grok-retry"
    });
    assert.equal(replayed.configRevision, activated.configRevision);
    assert.equal(replayed.accountRevision, activated.accountRevision);
    const activatedStatus = await client.call("accounts.status", {});
    assert.equal(
      activatedStatus.accounts.find((entry) => entry.label === "xai-transaction@example.com")
        ?.configured,
      true
    );

    const beforeClaude = await client.call("daemon.status", {});
    const claudeActivation = {
      kind: "claude-code" as const,
      accounts: [
        {
          label: "claude-work",
          credential: {
            claudeAiOauth: {
              accessToken: "claude-transaction-access",
              refreshToken: "claude-transaction-refresh",
              expiresAt: Date.now() + 3_600_000
            }
          }
        }
      ]
    };
    failActivation = true;
    await assert.rejects(
      client.call("accounts.enrollActivate", claudeActivation, {
        idempotencyKey: "activate-claude-failure"
      }),
      (error: unknown) => error instanceof ControlError
    );
    failActivation = false;
    const claudePath = join(stateHome, "subscriptions", "claude-code", "claude-work.json");
    assert.equal(existsSync(claudePath), false);
    assert.equal(existsSync(join(stateHome, "account-transactions")), false);
    assert.equal(
      (await client.call("daemon.status", {})).configRevision,
      beforeClaude.configRevision
    );
    assert.equal(
      (await client.call("daemon.status", {})).accountRevision,
      beforeClaude.accountRevision
    );

    await withMockAnthropicDiscovery(async () => {
      const claudeActivated = await client.call("accounts.enrollActivate", claudeActivation, {
        idempotencyKey: "activate-claude"
      });
      assert.equal(claudeActivated.activated, true);
      assert.equal(claudeActivated.configRevision, beforeClaude.configRevision + 1);
      assert.equal(claudeActivated.accountRevision, beforeClaude.accountRevision + 1);
      assert.equal(existsSync(claudePath), true);
      assert.match(readFileSync(configPath, "utf8"), /claude-code:/);
      assert.doesNotMatch(
        JSON.stringify(claudeActivated),
        /claude-transaction-access|claude-transaction-refresh/
      );
      const claudeReplay = await client.call("accounts.enrollActivate", claudeActivation, {
        idempotencyKey: "activate-claude-retry"
      });
      assert.equal(claudeReplay.configRevision, claudeActivated.configRevision);
      assert.equal(claudeReplay.accountRevision, claudeActivated.accountRevision);
      assert.equal(
        (await client.call("accounts.status", {})).accounts.find(
          (entry) => entry.subscriptionKind === "claude-code" && entry.label === "claude-work"
        )?.configured,
        true
      );
      assert.equal(
        (
          await client.call(
            "accounts.remove",
            { kind: "claude-code", label: "claude-work" },
            { idempotencyKey: "remove-claude-work" }
          )
        ).removed,
        true
      );
      assert.equal(existsSync(claudePath), false);
    });

    const removed = await client.call(
      "accounts.remove",
      { kind: "gemini", label: "antigravity-user@example.com" },
      { idempotencyKey: "remove-gemini" }
    );
    assert.equal(removed.removed, true);
    assert.equal(existsSync(join(authDirectory, "antigravity-user@example.com.json")), false);
  } finally {
    await daemon.close();
  }
  const survivors = readFileSync(markerPath, "utf8")
    .trim()
    .split("\n")
    .map(Number)
    .filter(processAlive);
  for (const pid of survivors) process.kill(pid, "SIGKILL");
  assert.deepEqual(survivors, [], "daemon shutdown must stop the managed sidecar");
  rmSync(root, { recursive: true, force: true });
});
