import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import { fetchAcpRegistry, installAcpAdapters } from "../acp/registry.js";

const FAKE_REGISTRY = {
  agents: [
    {
      id: "codex-cli",
      name: "Codex CLI",
      version: "0.16.0",
      description: "ACP adapter for OpenAI's coding assistant",
      distribution: { type: "npm", package: "@zed-industries/codex-acp" }
    },
    {
      id: "claude-agent",
      name: "Claude Agent",
      version: "0.46.0",
      description: "ACP wrapper for Anthropic's Claude",
      distribution: { type: "npm", package: "@agentclientprotocol/claude-agent-acp" }
    },
    {
      id: "no-distribution",
      name: "Broken",
      version: "1.0.0"
    }
  ]
};

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("fetchAcpRegistry normalizes agent metadata", async () => {
  const registry = await withFetch(
    async () => Response.json(FAKE_REGISTRY),
    () => runRouteKitEffect(fetchAcpRegistry())
  );
  const ids = registry.agents.map((agent) => agent.id);
  assert.ok(ids.includes("codex-cli"));
  assert.ok(ids.includes("claude-agent"));
});

test("installAcpAdapters writes metadata for known agents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-registry-"));
  try {
    const installed = await withFetch(
      async () => Response.json(FAKE_REGISTRY),
      () =>
        runRouteKitEffect(
          installAcpAdapters({
            agentIds: ["codex-cli", "claude-agent"],
            installDir: dir
          })
        )
    );
    assert.equal(installed.length, 2);
    const codex = JSON.parse(readFileSync(join(dir, "codex-cli.json"), "utf8")) as {
      id: string;
      version: string;
      distribution: Record<string, unknown>;
    };
    assert.equal(codex.id, "codex-cli");
    assert.equal(codex.version, "0.16.0");
    assert.equal(codex.distribution.package, "@zed-industries/codex-acp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installAcpAdapters rejects unknown ids and missing distribution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-registry-"));
  try {
    await withFetch(
      async () => Response.json(FAKE_REGISTRY),
      async () => {
        await assert.rejects(
          () => runRouteKitEffect(installAcpAdapters({ agentIds: ["missing"], installDir: dir })),
          /no agent with id "missing"/
        );
        await assert.rejects(
          () =>
            runRouteKitEffect(
              installAcpAdapters({
                agentIds: ["no-distribution"],
                installDir: dir
              })
            ),
          /no distribution metadata/
        );
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
