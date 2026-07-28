import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { gunzipSync, inflateSync } from "node:zlib";

import type { ModelCallRecord } from "@velum-labs/routekit-gateway";
import type { ConsentDecision } from "@velum-labs/routekit-telemetry-core";
import {
  DaemonTelemetry,
  GatewayTelemetryAggregator,
  type TelemetryTransportClient,
  type TelemetryTransportPayload
} from "../telemetry.js";

function consent(
  enabled = true,
  categories: Partial<ConsentDecision["categories"]> = {}
): ConsentDecision {
  return {
    enabled,
    source: "config",
    categories: { usage: true, reliability: true, adoption: true, ...categories },
    ...(enabled ? { installId: "stable-install" } : {})
  };
}

function record(overrides: Partial<ModelCallRecord> = {}): ModelCallRecord {
  return {
    call_id: "forbidden-call-id",
    endpoint_id: "forbidden-endpoint",
    model: "openai/gpt-5.2",
    request_hash: "forbidden-request-hash",
    response_hash: "forbidden-response-hash",
    messages: [{ role: "user", content: "forbidden-body" }],
    status: "succeeded",
    side_effects: "none",
    started_at: "2026-07-28T12:34:56.789Z",
    latency_ms: 1_500,
    usage: { prompt_tokens: 2_000, completion_tokens: 20 },
    metadata: {
      dialect: "openai-responses",
      stream: true,
      attribution: {
        provider: "openai",
        effective_model: "openai/gpt-5.2",
        billing_mode: "api_key",
        retries: 1,
        account_failovers: 1,
        principal: { token_id: "forbidden-principal" },
        account: { seat: "forbidden-account" }
      },
      raw_error: "forbidden-error",
      cost_estimate_usd: 12.3456789
    },
    ...overrides
  };
}

function fixture(decision = consent(), env: NodeJS.ProcessEnv = { ROUTEKIT_POSTHOG_KEY: "key" }) {
  const payloads: TelemetryTransportPayload[] = [];
  let created = 0;
  let flushed = 0;
  let shutdown = 0;
  const client: TelemetryTransportClient = {
    capture: (payload) => {
      payloads.push(payload);
    },
    flush: async () => {
      flushed += 1;
    },
    shutdown: async () => {
      shutdown += 1;
    }
  };
  const telemetry = new DaemonTelemetry({
    env,
    resolveConsent: () => decision,
    factory: () => {
      created += 1;
      return client;
    },
    shutdownTimeoutMs: 20
  });
  return {
    telemetry,
    payloads,
    created: () => created,
    flushed: () => flushed,
    shutdown: () => shutdown
  };
}

test("transport stays absent while disabled, DNT-equivalent, category-disabled, or unconfigured", () => {
  for (const [decision, env] of [
    [consent(false), { ROUTEKIT_POSTHOG_KEY: "key" }],
    [consent(true, { reliability: false }), { ROUTEKIT_POSTHOG_KEY: "key" }],
    [consent(), {}]
  ] as const) {
    const item = fixture(decision, env);
    assert.equal(
      item.telemetry.capture("routekit.daemon_lifecycle", {
        action: "started",
        outcome: "success",
        supervisor: "unknown",
        version: "test"
      }),
      false
    );
    assert.equal(item.created(), 0);
  }
});

test("transport payload has stable identity and mandatory privacy flags", () => {
  const item = fixture();
  assert.equal(
    item.telemetry.capture("routekit.daemon_lifecycle", {
      action: "started",
      outcome: "success",
      supervisor: "unknown",
      version: "test"
    }),
    true
  );
  assert.equal(
    item.telemetry.capture("routekit.daemon_lifecycle", {
      action: "reloaded",
      outcome: "success",
      supervisor: "unknown",
      version: "test"
    }),
    true
  );
  assert.equal(item.created(), 1);
  assert.deepEqual(
    item.payloads.map((payload) => payload.distinctId),
    ["stable-install", "stable-install"]
  );
  assert.equal(item.payloads[0]?.disableGeoip, true);
  assert.equal(item.payloads[0]?.properties.$process_person_profile, false);
  assert.equal(item.payloads[0]?.properties.$ip, null);
});

test("real PostHog transport serializes one anonymous privacy-hardened batch", async () => {
  const requests: Array<{ url: string | undefined; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body = Buffer.concat(chunks);
      if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      if (request.headers["content-encoding"] === "deflate") body = inflateSync(body);
      requests.push({ url: request.url, body: body.toString("utf8") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const telemetry = new DaemonTelemetry({
    env: {
      ROUTEKIT_POSTHOG_KEY: "phc_local_test",
      ROUTEKIT_POSTHOG_HOST: `http://127.0.0.1:${port}`
    },
    resolveConsent: () => consent()
  });
  try {
    assert.equal(
      telemetry.capture("routekit.command_completed", {
        command: "status",
        cli_version: "0.17.0",
        os: "darwin",
        arch: "arm64",
        node_major: "22",
        duration_bucket: "<1s",
        outcome: "success",
        exit_kind: "success",
        is_ci: false,
        target_kind: "local"
      }),
      true
    );
    await telemetry.flush();
    await telemetry.shutdown();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "/batch/");
  const batch = JSON.parse(requests[0]!.body) as {
    batch: Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }>;
  };
  const event = batch.batch[0]!;
  assert.equal(event.event, "routekit.command_completed");
  assert.equal(event.distinct_id, "stable-install");
  assert.equal(event.properties.$process_person_profile, false);
  assert.equal(event.properties.$ip, null);
  assert.equal(event.properties.$geoip_disable, true);
  assert.doesNotMatch(JSON.stringify(event), /prompt|argv|cwd|stack|api_key/i);
});

test("out-of-band consent revoke discards the real PostHog queue without a request", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  let decision = consent();
  const telemetry = new DaemonTelemetry({
    env: {
      ROUTEKIT_POSTHOG_KEY: "phc_local_test",
      ROUTEKIT_POSTHOG_HOST: `http://127.0.0.1:${port}`
    },
    resolveConsent: () => decision
  });
  try {
    assert.equal(
      telemetry.capture("routekit.daemon_lifecycle", {
        action: "started",
        outcome: "success",
        supervisor: "unknown",
        version: "test"
      }),
      true
    );
    decision = consent(false);
    assert.equal(
      telemetry.capture("routekit.daemon_lifecycle", {
        action: "stopped",
        outcome: "success",
        supervisor: "unknown",
        version: "test"
      }),
      false
    );
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await telemetry.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(requests, 0);
});

test("transport failures are isolated and shutdown is bounded", async () => {
  const telemetry = new DaemonTelemetry({
    env: { ROUTEKIT_POSTHOG_KEY: "key" },
    resolveConsent: () => consent(),
    factory: () => ({
      capture: () => {
        throw new Error("capture failed");
      },
      flush: async () => {
        throw new Error("flush failed");
      },
      shutdown: async () => await new Promise(() => undefined)
    }),
    shutdownTimeoutMs: 20
  });
  assert.equal(
    telemetry.capture("routekit.daemon_lifecycle", {
      action: "started",
      outcome: "success",
      supervisor: "unknown",
      version: "test"
    }),
    false
  );
  const started = Date.now();
  await telemetry.shutdown();
  assert.ok(Date.now() - started < 200);
});

test("key transitions retire stale transports and consent denial never flushes implicitly", async () => {
  const env: NodeJS.ProcessEnv = { ROUTEKIT_POSTHOG_KEY: "key-one" };
  let decision = consent();
  const clients: Array<{ shutdowns: number; optOuts: number }> = [];
  const telemetry = new DaemonTelemetry({
    env,
    resolveConsent: () => decision,
    factory: () => {
      const state = { shutdowns: 0, optOuts: 0 };
      clients.push(state);
      return {
        capture: () => undefined,
        flush: async () => undefined,
        optOut: async () => {
          state.optOuts += 1;
        },
        shutdown: async () => {
          state.shutdowns += 1;
        }
      };
    }
  });
  assert.equal(
    telemetry.capture("routekit.daemon_lifecycle", {
      action: "started",
      outcome: "success",
      supervisor: "unknown",
      version: "test"
    }),
    true
  );
  env.ROUTEKIT_POSTHOG_KEY = "key-two";
  assert.equal(
    telemetry.capture("routekit.daemon_lifecycle", {
      action: "reloaded",
      outcome: "success",
      supervisor: "unknown",
      version: "test"
    }),
    true
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clients[0]?.shutdowns, 1);
  decision = consent(false);
  assert.equal(
    telemetry.capture("routekit.daemon_lifecycle", {
      action: "stopped",
      outcome: "success",
      supervisor: "unknown",
      version: "test"
    }),
    false
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clients[1]?.optOuts, 1);
  assert.equal(clients[1]?.shutdowns, 1);
  await telemetry.shutdown();
  assert.equal(clients[1]?.shutdowns, 1);
  assert.equal(clients.length, 2);
});

test("aggregator groups locally and emits no per-call event", () => {
  const item = fixture();
  const aggregator = new GatewayTelemetryAggregator({
    telemetry: item.telemetry,
    version: "0.17.0",
    flushIntervalMs: 60_000
  });
  aggregator.record(record());
  aggregator.record(record({ call_id: "another-sensitive-id" }));
  assert.equal(item.payloads.length, 0);
  assert.equal(aggregator.size(), 1);
  aggregator.flush();
  assert.equal(item.payloads.length, 2);
  assert.deepEqual(
    item.payloads.map((payload) => payload.event),
    ["routekit.gateway_usage_summary", "routekit.gateway_reliability_summary"]
  );
  assert.equal(item.payloads[0]?.properties.request_count_bucket, "2-5");
  assert.equal("outcome" in item.payloads[0]!.properties, false);
  assert.equal("latency_bucket" in item.payloads[0]!.properties, false);
  assert.equal("input_token_bucket" in item.payloads[1]!.properties, false);
  assert.equal("billing_mode" in item.payloads[1]!.properties, false);
  assert.equal(aggregator.size(), 0);
  assert.doesNotMatch(JSON.stringify(item.payloads), /forbidden|12\.3456789|2026-07-28/);
  aggregator.close();
});

test("aggregator bounds cardinality and keeps groups when enqueue fails", () => {
  const successful = fixture();
  const aggregator = new GatewayTelemetryAggregator({
    telemetry: successful.telemetry,
    version: "0.17.0",
    groupLimit: 2
  });
  aggregator.record(record());
  aggregator.record(
    record({
      metadata: {
        ...record().metadata,
        attribution: {
          ...(record().metadata?.attribution as object),
          effective_model: "openai/gpt-5.3"
        }
      }
    })
  );
  aggregator.record(
    record({
      metadata: {
        ...record().metadata,
        attribution: {
          ...(record().metadata?.attribution as object),
          effective_model: "openai/gpt-5.4"
        }
      }
    })
  );
  assert.equal(aggregator.size(), 2);
  aggregator.close();

  const failing = new GatewayTelemetryAggregator({
    telemetry: { permitted: () => true, capture: () => false },
    version: "0.17.0"
  });
  failing.record(record());
  failing.flush();
  assert.equal(failing.size(), 1);
  failing.close();
});

test("aggregator gates collection and each payload family on live categories", () => {
  const disabled = new GatewayTelemetryAggregator({
    telemetry: fixture(consent(false)).telemetry,
    version: "0.17.0"
  });
  disabled.record(record());
  assert.equal(disabled.size(), 0);
  disabled.close();

  for (const [categories, expected] of [
    [{ usage: true, reliability: false }, ["routekit.gateway_usage_summary"]],
    [{ usage: false, reliability: true }, ["routekit.gateway_reliability_summary"]]
  ] as const) {
    const item = fixture(consent(true, categories));
    const aggregator = new GatewayTelemetryAggregator({
      telemetry: item.telemetry,
      version: "0.17.0"
    });
    aggregator.record(record());
    aggregator.flush();
    assert.deepEqual(
      item.payloads.map((payload) => payload.event),
      expected
    );
    assert.equal(aggregator.size(), 0);
    aggregator.close();
  }
});

test("aggregator discards opted-out summaries before a category or identity can be re-enabled", () => {
  const captured: string[] = [];
  const aggregator = new GatewayTelemetryAggregator({
    telemetry: {
      permitted: () => true,
      capture: (name) => {
        captured.push(name);
        return true;
      }
    },
    version: "0.17.0"
  });
  aggregator.record(record());
  aggregator.discard("usage");
  aggregator.flush();
  assert.deepEqual(captured, ["routekit.gateway_reliability_summary"]);
  assert.equal(aggregator.size(), 0);

  aggregator.record(record());
  aggregator.discard();
  aggregator.flush();
  assert.deepEqual(captured, ["routekit.gateway_reliability_summary"]);
  assert.equal(aggregator.size(), 0);
  aggregator.close();
});

test("aggregator retains a group until every currently permitted family enqueues", () => {
  const captured: string[] = [];
  let reliabilitySucceeds = false;
  const aggregator = new GatewayTelemetryAggregator({
    telemetry: {
      permitted: () => true,
      capture: (name) => {
        captured.push(name);
        return name === "routekit.gateway_usage_summary" || reliabilitySucceeds;
      }
    },
    version: "0.17.0"
  });
  aggregator.record(record());
  aggregator.flush();
  assert.equal(aggregator.size(), 1);
  reliabilitySucceeds = true;
  aggregator.flush();
  assert.equal(aggregator.size(), 0);
  assert.deepEqual(captured, [
    "routekit.gateway_usage_summary",
    "routekit.gateway_reliability_summary",
    "routekit.gateway_reliability_summary"
  ]);
  aggregator.close();
});

test("serialized payloads reject adversarial sensitive canaries across all families", () => {
  const item = fixture();
  const families = [
    [
      "routekit.command_completed",
      {
        command: "status",
        cli_version: "0.17.0",
        os: "darwin",
        arch: "arm64",
        node_major: "22",
        duration_bucket: "<1s",
        outcome: "success",
        exit_kind: "success",
        is_ci: false,
        target_kind: "local"
      }
    ],
    [
      "routekit.product_operation_completed",
      { operation: "config_update", outcome: "error", duration_bucket: "<1s", version: "0.17.0" }
    ],
    [
      "routekit.daemon_lifecycle",
      { action: "started", outcome: "success", supervisor: "detached", version: "0.17.0" }
    ],
    [
      "routekit.telemetry_preference_changed",
      { action: "master", enabled: true, source: "config", version: "0.17.0" }
    ]
  ] as const;
  for (const [name, properties] of families) item.telemetry.capture(name, properties as never);
  const aggregator = new GatewayTelemetryAggregator({
    telemetry: item.telemetry,
    version: "0.17.0"
  });
  aggregator.record(
    record({
      metadata: {
        ...record().metadata,
        prompt: "forbidden-prompt",
        source_path: "/Users/private/source.ts",
        api_key: "sk-secret",
        oauth_token: "oauth-secret",
        account_id: "acct-secret",
        principal_label: "private-user",
        request_body: "raw-body",
        raw_error: "stack trace",
        exact_cost: 9.87654321,
        exact_usage: 2345,
        exact_time: "2026-07-28T12:34:56Z"
      }
    })
  );
  aggregator.flush();
  const serialized = JSON.stringify(item.payloads);
  for (const canary of [
    "forbidden-prompt",
    "/Users/private",
    "sk-secret",
    "oauth-secret",
    "acct-secret",
    "private-user",
    "raw-body",
    "stack trace",
    "9.87654321",
    "2345",
    "2026-07-28T12:34:56Z",
    "forbidden-call-id",
    "forbidden-request-hash"
  ]) {
    assert.doesNotMatch(serialized, new RegExp(canary.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }
  assert.match(serialized, /openai\/gpt-5\.2/);
  assert.match(serialized, /1k-10k/);
  aggregator.close();
});
