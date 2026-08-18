import assert from "node:assert/strict";
import test from "node:test";

import { ControlError } from "@velum-labs/routekit-runtime";
import type { RouteKitControlHandlers } from "../index.js";
import { createRouteKitControlHandler, validateRouteKitParams } from "../index.js";

test("method-specific validators reject malformed mutations at the protocol edge", () => {
  assert.throws(
    () => validateRouteKitParams("config.update", { document: "providers: {}" }),
    /expectedRevision/
  );
  assert.throws(() => validateRouteKitParams("providers.set", { provider: "openai" }), /enabled/);
  assert.throws(
    () =>
      validateRouteKitParams("accounts.enroll", {
        kind: "codex",
        label: "work"
      }),
    /credential/
  );
  assert.deepEqual(validateRouteKitParams("launcher.prepare", { tool: "codex", cwd: "/tmp" }), {
    tool: "codex",
    cwd: "/tmp"
  });
  assert.throws(
    () => validateRouteKitParams("launcher.prepare", { tool: "shell" }),
    /must be one of/
  );
  // `accounts.remove` kinds are connector-routed by the daemon; the protocol
  // edge still requires the identifying fields.
  assert.throws(() => validateRouteKitParams("accounts.remove", { label: "work" }), /kind/);
  assert.deepEqual(
    validateRouteKitParams("accounts.rename", {
      kind: "codex",
      source: "work",
      target: "personal"
    }),
    { kind: "codex", source: "work", target: "personal" }
  );
  assert.deepEqual(
    validateRouteKitParams("accounts.resetCredits", { kind: "codex", label: "work" }),
    { kind: "codex", label: "work" }
  );
  assert.throws(
    () => validateRouteKitParams("accounts.resetCredits", { kind: "claude-code", label: "work" }),
    /must be one of/
  );
  assert.throws(() => validateRouteKitParams("accounts.resetCredits", { kind: "codex" }), /label/);
  assert.deepEqual(
    validateRouteKitParams("accounts.redeemReset", {
      kind: "codex",
      label: "work",
      creditId: "RateLimitResetCredit_1",
      redeemRequestId: "req-1"
    }),
    {
      kind: "codex",
      label: "work",
      creditId: "RateLimitResetCredit_1",
      redeemRequestId: "req-1"
    }
  );
  assert.throws(
    () =>
      validateRouteKitParams("accounts.redeemReset", {
        kind: "claude-code",
        label: "work"
      }),
    /must be one of/
  );
  assert.throws(() => validateRouteKitParams("accounts.redeemReset", { kind: "codex" }), /label/);
  assert.throws(
    () =>
      validateRouteKitParams("accounts.rename", {
        kind: "gemini",
        source: "work",
        target: "personal"
      }),
    /must be one of/
  );
  assert.throws(
    () => validateRouteKitParams("accounts.rename", { kind: "codex", source: "work" }),
    /target/
  );
  assert.throws(
    () =>
      validateRouteKitParams("accounts.enroll", {
        kind: "github",
        label: "work",
        credential: {}
      }),
    /must be one of/
  );
  assert.throws(
    () =>
      validateRouteKitParams("accounts.enrollActivate", {
        kind: "gemini",
        accounts: []
      }),
    /one or more accounts/
  );
  assert.deepEqual(
    validateRouteKitParams("accounts.enrollActivate", {
      kind: "codex",
      accounts: [{ label: "work" }]
    }),
    { kind: "codex", accounts: [{ label: "work" }] }
  );
  assert.throws(() => validateRouteKitParams("calls.inspect", {}), /callId/);
  assert.deepEqual(validateRouteKitParams("calls.inspect", { callId: "model_call_test" }), {
    callId: "model_call_test"
  });
  assert.deepEqual(validateRouteKitParams("calls.leaderboard", {}), {});
  assert.deepEqual(
    validateRouteKitParams("calls.leaderboard", {
      by: "model",
      sort: "requests",
      limit: 5,
      window: "24h"
    }),
    { by: "model", sort: "requests", limit: 5, window: "24h" }
  );
  assert.throws(
    () => validateRouteKitParams("calls.leaderboard", { by: "seat" }),
    /must be one of/
  );
  assert.throws(
    () => validateRouteKitParams("calls.leaderboard", { limit: 0 }),
    /positive integer/
  );
  const evalSession = {
    purpose: "qualification",
    operationId: "run-1",
    allowedModels: ["openai/gpt-5.6-luna"],
    limits: {
      calls: 10,
      inputTokens: 100_000,
      outputTokens: 10_000,
      perCallOutputTokens: 1_000,
      wallTimeMs: 60_000
    },
    expiresInSeconds: 60
  } as const;
  assert.deepEqual(validateRouteKitParams("evalSession.open", evalSession), evalSession);
  assert.throws(
    () =>
      validateRouteKitParams("evalSession.open", {
        ...evalSession,
        allowedModels: ["auto"]
      }),
    /explicit provider\/model/
  );
  assert.throws(
    () =>
      validateRouteKitParams("evalSession.open", {
        ...evalSession,
        allowedModels: ["openai/gpt-5.6-luna", "openai/gpt-5.6-luna"]
      }),
    /duplicates/
  );
  assert.throws(
    () =>
      validateRouteKitParams("evalSession.open", {
        ...evalSession,
        limits: { ...evalSession.limits, outputTokens: 100 }
      }),
    /cannot exceed/
  );
  assert.throws(
    () =>
      validateRouteKitParams("evalSession.open", {
        ...evalSession,
        expiresInSeconds: 14_401
      }),
    /between 1 and 14400/
  );
  const activation = { version: 2, evidenceDigest: "evidence-1" };
  assert.deepEqual(
    validateRouteKitParams("evalRouting.activate", {
      expectedEvidenceDigest: null,
      activation
    }),
    { expectedEvidenceDigest: null, activation }
  );
  assert.throws(
    () =>
      validateRouteKitParams("evalRouting.activate", {
        expectedEvidenceDigest: "",
        activation
      }),
    /expectedEvidenceDigest/
  );
  assert.throws(
    () =>
      validateRouteKitParams("evalRouting.activate", {
        expectedEvidenceDigest: null
      }),
    /activation/
  );
  assert.deepEqual(validateRouteKitParams("telemetry.set", { enabled: true }), { enabled: true });
  assert.deepEqual(
    validateRouteKitParams("telemetry.set", { category: "usage", categoryEnabled: false }),
    { category: "usage", categoryEnabled: false }
  );
  assert.throws(() => validateRouteKitParams("telemetry.set", {}), /requires enabled or category/);
  assert.throws(
    () => validateRouteKitParams("telemetry.set", { category: "private", categoryEnabled: true }),
    /must be one of/
  );
  assert.throws(
    () => validateRouteKitParams("telemetry.set", { category: "usage" }),
    /categoryEnabled/
  );
  assert.throws(
    () => validateRouteKitParams("telemetry.set", { enabled: true, properties: {} }),
    /does not accept properties/
  );
  assert.throws(
    () => validateRouteKitParams("telemetry.schema", { extra: true }),
    /does not accept extra/
  );
  const command = {
    command: "providers.status",
    cli_version: "0.16.4",
    os: "darwin",
    arch: "arm64",
    node_major: "22",
    duration_bucket: "<1s",
    outcome: "success",
    exit_kind: "success",
    is_ci: false,
    target_kind: "local"
  } as const;
  assert.deepEqual(validateRouteKitParams("telemetry.captureCommand", command), command);
  assert.throws(
    () =>
      validateRouteKitParams("telemetry.captureCommand", { ...command, argv: ["secret-canary"] }),
    /unknown telemetry property|does not accept argv/
  );
  assert.throws(
    () =>
      validateRouteKitParams("telemetry.captureCommand", {
        ...command,
        command: "providers.status secret-canary"
      }),
    /invalid telemetry property/
  );
});

test("dispatcher rejects unknown methods and deduplicates idempotent mutations", async () => {
  let calls = 0;
  const handlers = new Proxy(
    {},
    {
      get: () => async () => {
        calls += 1;
        return {
          path: "/tmp/router.yaml",
          document: "providers: {}\n",
          revision: calls
        };
      }
    }
  ) as RouteKitControlHandlers;
  const dispatch = createRouteKitControlHandler(handlers);
  const context = {
    signal: new AbortController().signal,
    requestId: "request",
    idempotencyKey: "same"
  };
  const first = await dispatch("providers.set", { provider: "openai", enabled: true }, context);
  const second = await dispatch("providers.set", { provider: "openai", enabled: true }, context);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  await assert.rejects(
    Promise.resolve(dispatch("providers.set", { provider: "anthropic", enabled: true }, context)),
    (error: unknown) =>
      error instanceof ControlError &&
      error.code === "conflict" &&
      /different parameters/.test(error.message)
  );
  await assert.rejects(
    Promise.resolve().then(async () => await dispatch("unknown", {}, context)),
    (error: unknown) => error instanceof ControlError && error.code === "not_found"
  );
});

test("concurrent idempotent retries share one in-flight mutation", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handlers = new Proxy(
    {},
    {
      get: () => async () => {
        calls += 1;
        await gate;
        return {
          enabled: true,
          source: "config",
          categories: { usage: true, reliability: true, adoption: true },
          installIdPresent: true,
          destination: { provider: "posthog", host: "https://example.test", configured: true },
          schema: {}
        };
      }
    }
  ) as RouteKitControlHandlers;
  const dispatch = createRouteKitControlHandler(handlers);
  const context = {
    signal: new AbortController().signal,
    requestId: "concurrent",
    idempotencyKey: "one-invocation"
  };
  const first = dispatch("telemetry.set", { enabled: true }, context);
  const second = dispatch("telemetry.set", { enabled: true }, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, await second);
});

test("committed operation observer fires once after idempotency and receives no arbitrary payload", async () => {
  const commits: Array<{ method: string; serialized: string }> = [];
  const handlers = new Proxy(
    {},
    {
      get: () => async () => ({
        path: "/tmp/router.yaml",
        document: "providers: {}\n",
        revision: 2
      })
    }
  ) as RouteKitControlHandlers;
  const dispatch = createRouteKitControlHandler(handlers, {
    onCommitted: (method, params) => commits.push({ method, serialized: JSON.stringify(params) })
  });
  const context = {
    signal: new AbortController().signal,
    requestId: "observer",
    idempotencyKey: "same-operation"
  };
  await dispatch("providers.set", { provider: "unique-provider-canary", enabled: true }, context);
  await dispatch("providers.set", { provider: "unique-provider-canary", enabled: true }, context);
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.method, "providers.set");
});

test("control error observer isolates synchronous and unexpected handler failures", async () => {
  const errors: Array<{ method: string; code: string }> = [];
  const handlers = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        if (property === "providers.set") {
          throw new ControlError({ code: "bad_request", message: "expected failure" });
        }
        throw new Error("unexpected failure");
      }
    }
  ) as RouteKitControlHandlers;
  const dispatch = createRouteKitControlHandler(handlers, {
    onControlError: (method, _params, code) => errors.push({ method, code })
  });
  const context = {
    signal: new AbortController().signal,
    requestId: "error-observer"
  };
  await assert.rejects(
    async () => await dispatch("providers.set", { provider: "openai", enabled: true }, context),
    /expected failure/
  );
  await assert.rejects(
    async () => await dispatch("accounts.sync", {}, context),
    /unexpected failure/
  );
  assert.deepEqual(errors, [
    { method: "providers.set", code: "bad_request" },
    { method: "accounts.sync", code: "internal" }
  ]);
});
