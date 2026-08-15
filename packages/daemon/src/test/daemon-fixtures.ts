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
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { parse as parseYaml } from "yaml";
import { prepareAccountTransaction } from "../account-transaction.js";
import { startRouteKitDaemon } from "../index.js";
import type { TelemetryTransportPayload } from "../telemetry.js";

async function mockProvider(
  models: readonly Record<string, unknown>[] = [
    {
      id: "mock-model",
      object: "model",
      capabilities: { streaming: "supported", tools: "degraded" },
      supported_reasoning_levels: ["high"]
    }
  ]
): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: models
        })
      );
      return;
    }
    req.resume();
    req.on("end", () => {
      const send = (): void => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "daemon answer" },
                finish_reason: "stop"
              }
            ]
          })
        );
      };
      if (req.headers["x-test-slow"] === "1") {
        setTimeout(send, 500);
      } else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function withMockAnthropicDiscovery<T>(run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/models") {
      return new Response(JSON.stringify({ data: [{ id: "claude-test-model", type: "model" }] }), {
        headers: { "content-type": "application/json" }
      });
    }
    return await originalFetch(input, init);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withMockNativeDiscovery<T>(
  kind: "claude-code" | "codex",
  run: () => Promise<T>,
  options: { healthyUsage?: boolean } = {}
): Promise<T> {
  if (kind === "claude-code") return await withMockAnthropicDiscovery(run);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (
      url.hostname === "chatgpt.com" &&
      url.pathname.startsWith("/backend-api/codex/") &&
      url.pathname.endsWith("/models")
    ) {
      return Response.json({ models: [{ slug: "gpt-test-model" }] });
    }
    if (
      options.healthyUsage === true &&
      url.hostname === "chatgpt.com" &&
      url.pathname === "/backend-api/wham/usage"
    ) {
      return Response.json({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 10, reset_at: Date.now() / 1000 + 3_600 }
        }
      });
    }
    return await originalFetch(input, init);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function nativeCredential(kind: "claude-code" | "codex"): Record<string, unknown> {
  return kind === "claude-code"
    ? {
        claudeAiOauth: {
          accessToken: "test-access",
          refreshToken: "test-refresh",
          expiresAt: Date.now() + 3_600_000
        }
      }
    : {
        tokens: {
          access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.",
          refresh_token: "test-refresh",
          account_id: "acct-test"
        }
      };
}

for (const kind of ["claude-code", "codex"] as const) {
  test(`native ${kind} account rename preserves routing and usage state`, async () => {
    const root = mkdtempSync(join(tmpdir(), `routekit-daemon-rename-${kind}-`));
    const stateHome = join(root, "state");
    const configPath = join(root, "router.yaml");
    const accountsDirectory = join(stateHome, "subscriptions", kind);
    const sourcePath = join(accountsDirectory, "work.json");
    const targetPath = join(accountsDirectory, "personal.json");
    const occupiedPath = join(accountsDirectory, "occupied.json");
    const credential = `${JSON.stringify(nativeCredential(kind))}\n`;
    const coolingUntil = Date.now() + 60_000;
    mkdirSync(accountsDirectory, { recursive: true });
    writeFileSync(sourcePath, credential, { mode: 0o600 });
    writeFileSync(
      join(accountsDirectory, ".state.json"),
      JSON.stringify({
        version: 1,
        members: [{ id: "work", coolingUntil, cooldownRevision: 1 }]
      }),
      { mode: 0o600 }
    );
    writeFileSync(
      configPath,
      `providers:\n  ${kind}: {}\ndefaultModel: ${kind}/${
        kind === "claude-code" ? "claude-test-model" : "gpt-test-model"
      }\n`
    );
    try {
      await withMockNativeDiscovery(kind, async () => {
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
          const before = await runRouteKitEffect(client.call("daemon.status", {}));
          const beforeConfig = await runRouteKitEffect(client.call("config.get", {}));
          const renamed = await runRouteKitEffect(
            client.call(
              "accounts.rename",
              { kind, source: "work", target: "personal" },
              { idempotencyKey: `rename-${kind}-work` }
            )
          );
          assert.deepEqual(renamed, {
            renamed: true,
            revision: before.accountRevision + 1
          });
          assert.equal(existsSync(sourcePath), false);
          assert.equal(readFileSync(targetPath, "utf8"), credential);
          assert.deepEqual(await runRouteKitEffect(client.call("config.get", {})), beforeConfig);
          assert.deepEqual((await runRouteKitEffect(client.call("accounts.list", {}))).accounts, [
            { subscriptionKind: kind, label: "personal", connector: "native" }
          ]);
          const status = await runRouteKitEffect(client.call("accounts.status", {}));
          assert.equal(status.accounts[0]?.label, "personal");
          assert.equal(status.accounts[0]?.subscriptionKind, kind);
          const usage = (await runRouteKitEffect(client.call("accounts.usage", {}))) as {
            accountSets: Array<{
              members: Array<{ label: string; coolingUntil?: number }>;
            }>;
          };
          assert.equal(usage.accountSets[0]?.members[0]?.label, "personal");
          assert.equal(usage.accountSets[0]?.members[0]?.coolingUntil, coolingUntil);
          const tracker = JSON.parse(
            readFileSync(join(accountsDirectory, ".state.json"), "utf8")
          ) as { members: Array<{ id: string; coolingUntil?: number }> };
          assert.deepEqual(
            tracker.members.map((member) => [member.id, member.coolingUntil]),
            [["personal", coolingUntil]]
          );
          assert.equal(
            (await runRouteKitEffect(client.call("doctor.run", {}))).checks.find(
              (check) => check.name === "account/provider consistency"
            )?.ok,
            true
          );

          const afterRename = await runRouteKitEffect(client.call("daemon.status", {}));
          await assert.rejects(
            runRouteKitEffect(
              client.call(
                "accounts.rename",
                { kind, source: "missing", target: "available" },
                { idempotencyKey: `rename-${kind}-missing` }
              )
            ),
            (error: unknown) =>
              error instanceof ControlError &&
              error.code === "not_found" &&
              /not enrolled/.test(error.message)
          );
          writeFileSync(occupiedPath, credential, { mode: 0o600 });
          await assert.rejects(
            runRouteKitEffect(
              client.call(
                "accounts.rename",
                { kind, source: "personal", target: "occupied" },
                { idempotencyKey: `rename-${kind}-occupied` }
              )
            ),
            (error: unknown) =>
              error instanceof ControlError &&
              error.code === "conflict" &&
              /already enrolled/.test(error.message)
          );
          assert.equal(readFileSync(targetPath, "utf8"), credential);
          assert.equal(readFileSync(occupiedPath, "utf8"), credential);
          assert.deepEqual(await runRouteKitEffect(client.call("daemon.status", {})), afterRename);
          assert.equal(existsSync(join(stateHome, "account-transactions")), false);
        } finally {
          await daemon.close();
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const kind of ["claude-code", "codex"] as const) {
  test(`last sole ${kind} account leaves a healthy unconfigured daemon without provider credentials`, async () => {
    const root = mkdtempSync(join(tmpdir(), `routekit-daemon-sole-${kind}-`));
    const stateHome = join(root, "state");
    const configPath = join(root, "router.yaml");
    const accountsDirectory = join(stateHome, "subscriptions", kind);
    const accountPath = join(accountsDirectory, "only.json");
    mkdirSync(accountsDirectory, { recursive: true });
    writeFileSync(accountPath, JSON.stringify(nativeCredential(kind)), { mode: 0o600 });
    writeFileSync(
      configPath,
      [
        "providers:",
        `  ${kind}: {}`,
        `defaultModel: ${kind}/${kind === "claude-code" ? "claude-test-model" : "gpt-test-model"}`,
        ""
      ].join("\n")
    );
    try {
      await withMockNativeDiscovery(kind, async () => {
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
          const before = await runRouteKitEffect(client.call("daemon.status", {}));
          const result = await runRouteKitEffect(
            client.call(
              "accounts.remove",
              { kind, label: "only" },
              { idempotencyKey: `remove-only-${kind}` }
            )
          );
          assert.equal(result.removed, true);
          assert.equal(result.revision, before.accountRevision + 1);
          assert.equal(existsSync(accountPath), false);
          const after = await runRouteKitEffect(client.call("daemon.status", {}));
          assert.equal(after.configRevision, before.configRevision + 1);
          assert.equal(after.accountRevision, before.accountRevision + 1);
          const config = parseYaml(
            (await runRouteKitEffect(client.call("config.get", {}))).document
          ) as {
            providers: Record<string, unknown>;
            defaultModel?: string;
          };
          assert.deepEqual(Object.keys(config.providers), []);
          assert.equal(config.defaultModel, undefined);
          assert.deepEqual(
            (await runRouteKitEffect(client.call("providers.status", {}))).providers,
            []
          );
          const listed = await runRouteKitEffect(client.call("models.list", {}));
          assert.deepEqual(listed.models, []);
          assert.equal(listed.defaultModel, undefined);
          const currentStatus = await runRouteKitEffect(client.call("daemon.status", {}));
          assert.equal(currentStatus.dataUrl, daemon.dataUrl);
          assert.equal(currentStatus.draining, false);

          const doctor = await runRouteKitEffect(client.call("doctor.run", {}));
          assert.deepEqual(
            doctor.checks.find((check) => check.name === "provider configuration"),
            {
              name: "provider configuration",
              ok: false,
              detail: "no providers configured; run `routekit providers add <provider>`"
            }
          );
          assert.equal(
            doctor.checks.find((check) => check.name === "account/provider consistency")?.ok,
            true
          );
          await assert.rejects(
            runRouteKitEffect(client.call("launcher.prepare", { tool: "codex" })),
            (error: unknown) =>
              error instanceof ControlError &&
              error.code === "unavailable" &&
              /no advertised model with text output and tool support/.test(error.message)
          );

          assert.equal((await fetch(`${daemon.dataUrl}/health`)).status, 200);
          const dataToken = readFileSync(daemon.record.authTokenFile!, "utf8").trim();
          const gatewayModels = await fetch(`${daemon.dataUrl}/v1/models`, {
            headers: { authorization: `Bearer ${dataToken}` }
          });
          assert.equal(gatewayModels.status, 200);
          assert.deepEqual(await gatewayModels.json(), {
            object: "list",
            data: [],
            models: []
          });

          const unavailableResponse = await fetch(`${daemon.dataUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${dataToken}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              messages: [{ role: "user", content: "hello" }]
            })
          });
          assert.equal(unavailableResponse.status, 503);
          assert.match(await unavailableResponse.text(), /no model is available/);

          const modelResponse = await fetch(`${daemon.dataUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${dataToken}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              model: `${kind}/removed-model`,
              messages: [{ role: "user", content: "hello" }]
            })
          });
          assert.equal(modelResponse.status, 400);
          assert.match(await modelResponse.text(), /unknown model/);
          assert.equal(existsSync(join(stateHome, "account-transactions")), false);
        } finally {
          await daemon.close();
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return await predicate();
}

async function assertInterruptedNativeActivationRecovery(
  kind: "claude-code" | "codex"
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-recovery-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  const accountPath = join(stateHome, "subscriptions", kind, "interrupted.json");
  const priorConfig = "providers:\n  openai: {}\ndefaultModel: openai/mock-model\n";
  writeFileSync(configPath, priorConfig);
  prepareAccountTransaction({
    home: stateHome,
    configPath,
    accountPaths: [accountPath],
    kind,
    provider: kind,
    labels: ["interrupted"]
  });
  mkdirSync(dirname(accountPath), { recursive: true });
  writeFileSync(
    accountPath,
    JSON.stringify(
      kind === "claude-code"
        ? {
            claudeAiOauth: {
              accessToken: "interrupted-access",
              refreshToken: "interrupted-refresh"
            }
          }
        : {
            tokens: {
              access_token: "interrupted-access",
              refresh_token: "interrupted-refresh"
            }
          }
    )
  );
  writeFileSync(
    configPath,
    `providers:\n  openai: {}\n  ${kind}: {}\ndefaultModel: openai/mock-model\n`
  );
  writeFileSync(
    join(stateHome, "daemon-revisions.json"),
    JSON.stringify({ config: 1, accounts: 1, daemon: 0 })
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
    assert.equal(existsSync(accountPath), false);
    assert.equal(readFileSync(configPath, "utf8"), priorConfig);
    const client = new RouteKitControlClient({
      url: daemon.record.url,
      token: daemon.record.controlToken!
    });
    const accounts = await runRouteKitEffect(client.call("accounts.status", {}));
    assert.deepEqual(accounts.accounts, []);
    assert.deepEqual(accounts.recovery, {
      state: "recovered",
      recovered: 1,
      cleaned: 0
    });
    const doctor = await runRouteKitEffect(client.call("doctor.run", {}));
    assert.equal(
      doctor.checks.find((check) => check.name === "account activation recovery")?.detail,
      "recovered 1 interrupted operation(s)"
    );
    assert.doesNotMatch(JSON.stringify({ accounts, doctor }), /interrupted-access/);
  } finally {
    await daemon.close();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export {
  assertInterruptedNativeActivationRecovery,
  freePort,
  mockProvider,
  nativeCredential,
  processAlive,
  waitFor,
  withMockAnthropicDiscovery,
  withMockNativeDiscovery
};
