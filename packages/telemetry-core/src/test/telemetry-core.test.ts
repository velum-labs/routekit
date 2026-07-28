import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTelemetryEvent,
  createConsentManager,
  DEFAULT_TELEMETRY_CATEGORIES,
  TELEMETRY_SCHEMA_INVENTORY,
  telemetryStatusMetadata
} from "../index.js";

function fixture(ids = ["id-1", "id-2", "id-3"]) {
  const root = mkdtempSync(join(tmpdir(), "routekit-telemetry-"));
  let index = 0;
  const manager = createConsentManager({
    path: () => join(root, "consent.json"),
    environmentVariable: "ROUTEKIT_TELEMETRY",
    randomId: () => ids[index++] ?? `id-${index}`,
    now: () => new Date("2026-01-01T00:00:00.000Z")
  });
  return { root, path: join(root, "consent.json"), manager };
}

test("consent defaults off and migrates old files logically", () => {
  const { root, path, manager } = fixture();
  try {
    assert.deepEqual(manager.resolve({}), {
      enabled: false,
      source: "default",
      categories: DEFAULT_TELEMETRY_CATEGORIES
    });
    writeFileSync(path, JSON.stringify({ enabled: true, installId: "legacy" }));
    assert.deepEqual(manager.resolve({}), {
      enabled: true,
      source: "config",
      categories: DEFAULT_TELEMETRY_CATEGORIES,
      installId: "legacy"
    });
    writeFileSync(path, JSON.stringify({ enabled: false, installId: "must-disappear" }));
    assert.equal(manager.read()?.installId, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("consent truthy/falsy matrix, DNT precedence, corruption, and identity stability", () => {
  const { root, path, manager } = fixture();
  try {
    manager.enable();
    for (const value of ["1", "true", "TRUE", "on", "yes"]) {
      assert.equal(manager.resolve({ ROUTEKIT_TELEMETRY: value }).enabled, true, value);
    }
    for (const value of ["0", "false", "FALSE", "off", "no"]) {
      const decision = manager.resolve({ ROUTEKIT_TELEMETRY: value });
      assert.equal(decision.enabled, false, value);
      assert.equal(decision.source, "env");
    }
    for (const value of ["1", "true", "on", "yes"]) {
      const decision = manager.resolve({ ROUTEKIT_TELEMETRY: "1", DO_NOT_TRACK: value });
      assert.equal(decision.enabled, false, value);
      assert.equal(decision.source, "do-not-track");
    }
    manager.disable();
    const first = manager.resolve({ ROUTEKIT_TELEMETRY: "yes" });
    const second = manager.resolve({ ROUTEKIT_TELEMETRY: "yes" });
    assert.equal(first.installId, second.installId);
    writeFileSync(path, "{broken json");
    assert.equal(manager.resolve({}).source, "default");
    assert.equal(manager.resolve({}).enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("category changes, disable, re-enable, and identity reset preserve invariants", () => {
  const { root, path, manager } = fixture();
  try {
    assert.equal(manager.enable().installId, "id-1");
    manager.setCategory("usage", false);
    assert.equal(manager.resolve({}).categories.usage, false);
    assert.equal(manager.resetIdentity({})?.installId, "id-2");
    manager.disable();
    assert.equal(manager.resolve({}).installId, undefined);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).installId, undefined);
    assert.deepEqual(manager.resetIdentity({}), manager.read());
    assert.equal(manager.enable().installId, "id-3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("event builder validates exact schemas and privacy canaries", () => {
  assert.deepEqual(
    buildTelemetryEvent("routekit.gateway_usage_summary", {
      provider: "openai",
      model: "openai/gpt-5.2",
      dialect: "openai-responses",
      request_kind: "responses",
      stream: true,
      billing_mode: "metered-api",
      input_token_bucket: "1k-10k",
      output_token_bucket: "1-1k",
      request_count_bucket: "1",
      version: "0.17.0"
    }).properties.$ip,
    null
  );
  assert.equal(
    buildTelemetryEvent("routekit.gateway_reliability_summary", {
      provider: "openai",
      model: "openai/gpt-5.2",
      dialect: "openai-responses",
      request_kind: "responses",
      stream: true,
      outcome: "success",
      latency_bucket: "1-10s",
      retry_bucket: "1",
      failover: false,
      request_count_bucket: "1",
      version: "0.17.0"
    }).category,
    "reliability"
  );
  assert.throws(
    () =>
      (buildTelemetryEvent as (name: string, source: Record<string, unknown>) => unknown)(
        "routekit.unknown",
        {}
      ),
    /unknown telemetry event/
  );
  assert.throws(
    () => buildTelemetryEvent("routekit.command_completed", { path: "/tmp/a" } as never),
    /sensitive/
  );
  assert.throws(
    () => buildTelemetryEvent("routekit.command_completed", { command: "Bearer secret" } as never),
    /forbidden|missing/
  );
  assert.throws(
    () => buildTelemetryEvent("routekit.gateway_usage_summary", { provider: "open ai" } as never),
    /invalid|missing/
  );
  assert.throws(
    () => buildTelemetryEvent("routekit.gateway_usage_summary", { latency_ms: 12 } as never),
    /unknown/
  );
});

test("schema inventory exposes exact category-truthful event families and fields", () => {
  assert.deepEqual(TELEMETRY_SCHEMA_INVENTORY, {
    "routekit.command_completed": {
      category: "adoption",
      fields: [
        "command",
        "cli_version",
        "os",
        "arch",
        "node_major",
        "duration_bucket",
        "outcome",
        "exit_kind",
        "is_ci",
        "target_kind"
      ]
    },
    "routekit.product_operation_completed": {
      category: "adoption",
      fields: ["operation", "outcome", "duration_bucket", "version"]
    },
    "routekit.daemon_lifecycle": {
      category: "reliability",
      fields: ["action", "outcome", "supervisor", "version"]
    },
    "routekit.gateway_usage_summary": {
      category: "usage",
      fields: [
        "provider",
        "model",
        "dialect",
        "request_kind",
        "stream",
        "billing_mode",
        "input_token_bucket",
        "output_token_bucket",
        "request_count_bucket",
        "version"
      ]
    },
    "routekit.gateway_reliability_summary": {
      category: "reliability",
      fields: [
        "provider",
        "model",
        "dialect",
        "request_kind",
        "stream",
        "outcome",
        "latency_bucket",
        "retry_bucket",
        "failover",
        "request_count_bucket",
        "version"
      ]
    },
    "routekit.telemetry_preference_changed": {
      category: "adoption",
      fields: ["action", "category", "enabled", "source", "version"]
    }
  });
});

test("status exposes presence and exact schema without identity", () => {
  const status = telemetryStatusMetadata(
    {
      enabled: true,
      source: "config",
      categories: { usage: true, reliability: false, adoption: true },
      installId: "private"
    },
    { provider: "posthog", host: "https://us.i.posthog.com", configured: false }
  );
  assert.deepEqual(status, {
    enabled: true,
    source: "config",
    categories: { usage: true, reliability: false, adoption: true },
    installIdPresent: true,
    destination: { provider: "posthog", host: "https://us.i.posthog.com", configured: false },
    schema: TELEMETRY_SCHEMA_INVENTORY
  });
  assert.equal("installId" in status, false);
});
