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

test("native provider stays enabled until its last account is removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-native-remove-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  const accountsDirectory = join(stateHome, "subscriptions", "claude-code");
  const firstPath = join(accountsDirectory, "first.json");
  const lastPath = join(accountsDirectory, "last.json");
  mkdirSync(accountsDirectory, { recursive: true });
  for (const [path, suffix] of [
    [firstPath, "first"],
    [lastPath, "last"]
  ]) {
    writeFileSync(
      path!,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: `${suffix}-access`,
          refreshToken: `${suffix}-refresh`,
          expiresAt: Date.now() + 3_600_000
        }
      }),
      { mode: 0o600 }
    );
  }
  writeFileSync(
    configPath,
    [
      "providers:",
      "  openai: {}",
      "  claude-code:",
      "    strategy: round_robin",
      "defaultModel: claude-code/claude-test-model",
      ""
    ].join("\n")
  );
  const upstream = await mockProvider();
  try {
    await withMockAnthropicDiscovery(async () => {
      const daemon = await startRouteKitDaemon({
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
      try {
        const client = new RouteKitControlClient({
          url: daemon.record.url,
          token: daemon.record.controlToken!
        });
        const initial = await client.call("daemon.status", {});

        const first = await client.call(
          "accounts.remove",
          { kind: "claude-code", label: "first" },
          { idempotencyKey: "remove-first-claude" }
        );
        assert.equal(first.removed, true);
        assert.equal(existsSync(firstPath), false);
        assert.equal(existsSync(lastPath), true);
        const afterFirst = await client.call("daemon.status", {});
        assert.equal(afterFirst.configRevision, initial.configRevision);
        assert.equal(afterFirst.accountRevision, initial.accountRevision + 1);
        const firstConfig = parseYaml((await client.call("config.get", {})).document) as {
          providers: Record<string, unknown>;
          defaultModel?: string;
        };
        assert.ok(firstConfig.providers["claude-code"] !== undefined);
        assert.equal(firstConfig.defaultModel, "claude-code/claude-test-model");

        const last = await client.call(
          "accounts.remove",
          { kind: "claude-code", label: "last" },
          { idempotencyKey: "remove-last-claude" }
        );
        assert.equal(last.removed, true);
        assert.equal(existsSync(lastPath), false);
        const afterLast = await client.call("daemon.status", {});
        assert.equal(afterLast.configRevision, afterFirst.configRevision + 1);
        assert.equal(afterLast.accountRevision, afterFirst.accountRevision + 1);
        const lastConfig = parseYaml((await client.call("config.get", {})).document) as {
          providers: Record<string, unknown>;
          defaultModel?: string;
        };
        assert.equal(lastConfig.providers["claude-code"], undefined);
        assert.equal(lastConfig.defaultModel, undefined);
        assert.deepEqual(
          (await client.call("providers.status", {})).providers.map(
            (provider) => provider.provider
          ),
          ["openai"]
        );
        assert.deepEqual(
          (await client.call("models.list", {})).models.map((model) => model.id),
          ["openai/mock-model"]
        );
        assert.equal(
          (await client.call("doctor.run", {})).checks.find(
            (check) => check.name === "account/provider consistency"
          )?.ok,
          true
        );
        assert.equal(existsSync(join(stateHome, "account-transactions")), false);

        const repeated = await client.call(
          "accounts.remove",
          { kind: "claude-code", label: "last" },
          { idempotencyKey: "remove-last-claude-again" }
        );
        assert.equal(repeated.removed, false);
        assert.deepEqual(await client.call("daemon.status", {}), afterLast);
      } finally {
        await daemon.close();
      }
    });
  } finally {
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native removal failure before deletion cleans its prepared transaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-remove-symlink-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  const accountsDirectory = join(stateHome, "subscriptions", "claude-code");
  const externalPath = join(root, "external.json");
  const accountPath = join(accountsDirectory, "linked.json");
  mkdirSync(accountsDirectory, { recursive: true });
  writeFileSync(externalPath, JSON.stringify(nativeCredential("claude-code")), {
    mode: 0o600
  });
  symlinkSync(externalPath, accountPath);
  writeFileSync(
    configPath,
    ["providers:", "  openai: {}", "defaultModel: openai/mock-model", ""].join("\n")
  );
  const upstream = await mockProvider();
  const daemon = await startRouteKitDaemon({
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
  try {
    const client = new RouteKitControlClient({
      url: daemon.record.url,
      token: daemon.record.controlToken!
    });
    const before = await client.call("daemon.status", {});
    await assert.rejects(
      client.call(
        "accounts.remove",
        { kind: "claude-code", label: "linked" },
        { idempotencyKey: "remove-linked-claude" }
      ),
      (error: unknown) => error instanceof ControlError
    );
    assert.equal(existsSync(accountPath), true);
    assert.equal(existsSync(externalPath), true);
    assert.deepEqual(await client.call("daemon.status", {}), before);
    assert.equal(existsSync(join(stateHome, "account-transactions")), false);
  } finally {
    await daemon.close();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed last native account removal restores credential and config", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-native-rollback-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  const accountsDirectory = join(stateHome, "subscriptions", "claude-code");
  const accountPath = join(accountsDirectory, "work.json");
  mkdirSync(accountsDirectory, { recursive: true });
  const credential = JSON.stringify({
    claudeAiOauth: {
      accessToken: "rollback-access",
      refreshToken: "rollback-refresh",
      expiresAt: Date.now() + 3_600_000
    }
  });
  writeFileSync(accountPath, credential, { mode: 0o600 });
  writeFileSync(
    configPath,
    [
      "providers:",
      "  openai: {}",
      "  claude-code: {}",
      "defaultModel: claude-code/claude-test-model",
      ""
    ].join("\n")
  );
  const upstream = await mockProvider();
  try {
    await withMockAnthropicDiscovery(async () => {
      const daemon = await startRouteKitDaemon({
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
      try {
        const client = new RouteKitControlClient({
          url: daemon.record.url,
          token: daemon.record.controlToken!
        });
        const beforeStatus = await client.call("daemon.status", {});
        const beforeDocument = (await client.call("config.get", {})).document;
        await upstream.close();

        await assert.rejects(
          client.call(
            "accounts.remove",
            { kind: "claude-code", label: "work" },
            { idempotencyKey: "remove-last-claude-failure" }
          )
        );
        assert.equal(readFileSync(accountPath, "utf8"), credential);
        assert.equal((await client.call("config.get", {})).document, beforeDocument);
        assert.deepEqual(await client.call("daemon.status", {}), beforeStatus);
        assert.equal(existsSync(join(stateHome, "account-transactions")), false);
      } finally {
        await daemon.close();
      }
    });
  } finally {
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});
