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

test("second daemon cannot claim authority and generations remain monotonic", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-singleton-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  writeFileSync(configPath, "providers:\n  openai: {}\ndefaultModel: openai/mock-model\n");
  const upstream = await mockProvider();
  const options = {
    packageVersion: "1.0.0",
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
  } as const;
  const first = await startRouteKitDaemon(options);
  try {
    await assert.rejects(startRouteKitDaemon(options), (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /already running/);
      assert.equal(
        JSON.stringify(error).includes(first.record.controlToken ?? "impossible-token"),
        false,
        "singleton conflicts must not disclose the control credential"
      );
      return true;
    });
    assert.equal(first.record.generation, 1);
  } finally {
    await first.close();
  }
  const second = await startRouteKitDaemon(options);
  try {
    assert.equal(second.record.generation, 2);
  } finally {
    await second.close();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon recovers interrupted activation before loading config or starting routers", async () => {
  await assertInterruptedNativeActivationRecovery("codex");
});

test("daemon recovers interrupted Claude activation before loading config or starting routers", async () => {
  await assertInterruptedNativeActivationRecovery("claude-code");
});

test("daemon telemetry emits lifecycle and committed operations exactly once without parameters", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-telemetry-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  mkdirSync(stateHome, { recursive: true });
  writeFileSync(
    join(stateHome, "telemetry.json"),
    JSON.stringify({
      enabled: true,
      installId: "telemetry-test-install",
      categories: { usage: true, reliability: true, adoption: true }
    })
  );
  writeFileSync(configPath, "providers:\n  openai: {}\ndefaultModel: openai/mock-model\n");
  const upstream = await mockProvider();
  const payloads: TelemetryTransportPayload[] = [];
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
      OPENAI_API_KEY: "unique-api-key-canary",
      OPENAI_BASE_URL: upstream.url,
      ROUTEKIT_POSTHOG_KEY: "",
      ROUTEKIT_PORTLESS: "0"
    },
    telemetryTransportFactory: () => ({
      capture: (payload) => payloads.push(payload),
      flush: async () => undefined,
      shutdown: async () => undefined
    })
  });
  try {
    const client = new RouteKitControlClient({
      url: daemon.record.url,
      token: daemon.record.controlToken!
    });
    assert.equal((await client.call("telemetry.get", {})).destination.configured, true);
    const snapshot = await client.call("config.get", {});
    const params = {
      expectedRevision: snapshot.revision,
      document: "providers:\n  openai: {}\ndefaultModel: openai/mock-model\n"
    };
    await client.call("config.update", params, { idempotencyKey: "telemetry-once" });
    await client.call("config.update", params, { idempotencyKey: "telemetry-once" });
    assert.equal(
      payloads.filter((item) => item.event === "routekit.product_operation_completed").length,
      1
    );
    const serialized = JSON.stringify(payloads);
    assert.doesNotMatch(
      serialized,
      /unique-api-key-canary|OPENAI_BASE_URL|expectedRevision|document|telemetry-once/
    );
    assert.equal(
      payloads.filter(
        (item) => item.event === "routekit.daemon_lifecycle" && item.properties.action === "started"
      ).length,
      1
    );
  } finally {
    await daemon.close();
    await upstream.close();
    assert.equal(
      payloads.filter(
        (item) => item.event === "routekit.daemon_lifecycle" && item.properties.action === "stopped"
      ).length,
      1
    );
    rmSync(root, { recursive: true, force: true });
  }
});
