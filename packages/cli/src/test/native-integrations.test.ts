import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deleteNativeIntegration,
  getNativeIntegration,
  markNativeIntegrationTokenRevoked,
  nativeIntegrationsPath,
  putNativeIntegration
} from "../native-integrations.js";
import { routekitVersion } from "../state.js";

async function withRouteKitHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "routekit-native-integrations-"));
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = home;
  try {
    await run(home);
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("native integration registry is private and never records token plaintext", async () => {
  await withRouteKitHome(async () => {
    await putNativeIntegration({
      tool: "codex",
      configPath: "/tmp/codex/config.toml",
      target: { kind: "remote", name: "mini" },
      tokenId: "0123456789abcdef"
    });
    const path = nativeIntegrationsPath();
    assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const content = readFileSync(path, "utf8");
    assert.match(content, /0123456789abcdef/);
    assert.doesNotMatch(content, /plaintext-token|ROUTEKIT_GATEWAY_TOKEN|ANTHROPIC_AUTH_TOKEN/);
    assert.deepEqual(getNativeIntegration("codex", "/tmp/codex/config.toml"), {
      installVersion: 1,
      managedByVersion: routekitVersion(),
      tool: "codex",
      configPath: "/tmp/codex/config.toml",
      target: { kind: "remote", name: "mini" },
      tokenId: "0123456789abcdef"
    });
  });
});

test("native integration registry replaces, marks, and deletes entries atomically", async () => {
  await withRouteKitHome(async () => {
    const configPath = "/tmp/claude/settings.json";
    await putNativeIntegration({
      tool: "claude",
      configPath,
      target: { kind: "local" },
      tokenId: "0123456789abcdef"
    });
    await putNativeIntegration({
      tool: "claude",
      configPath,
      target: { kind: "remote", name: "mini" },
      tokenId: "fedcba9876543210"
    });
    await markNativeIntegrationTokenRevoked("claude", configPath);
    assert.deepEqual(getNativeIntegration("claude", configPath), {
      installVersion: 1,
      managedByVersion: routekitVersion(),
      tool: "claude",
      configPath,
      target: { kind: "remote", name: "mini" },
      tokenId: "fedcba9876543210",
      tokenRevoked: true
    });
    await deleteNativeIntegration("claude", configPath);
    assert.equal(getNativeIntegration("claude", configPath), undefined);
  });
});

test("native integration registry migrates legacy installs deterministically", async () => {
  await withRouteKitHome(async () => {
    const path = nativeIntegrationsPath();
    mkdirSync(join(path, ".."), { recursive: true });
    const legacy = {
      version: 1,
      integrations: [
        {
          tool: "codex",
          configPath: "/tmp/legacy/config.toml",
          target: { kind: "local" },
          tokenId: "0123456789abcdef"
        }
      ]
    };
    writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`);

    assert.deepEqual(getNativeIntegration("codex", "/tmp/legacy/config.toml"), {
      installVersion: 1,
      managedByVersion: routekitVersion(),
      ...legacy.integrations[0]
    });

    await putNativeIntegration(legacy.integrations[0] as {
      tool: "codex";
      configPath: string;
      target: { kind: "local" };
      tokenId: string;
    });
    const migrated = readFileSync(path, "utf8");
    assert.match(migrated, /"installVersion": 1/);
    assert.match(migrated, new RegExp(`"managedByVersion": "${routekitVersion()}"`));

    await putNativeIntegration(legacy.integrations[0] as {
      tool: "codex";
      configPath: string;
      target: { kind: "local" };
      tokenId: string;
    });
    assert.equal(readFileSync(path, "utf8"), migrated);
  });
});

test("native integration registry rejects future install versions", async () => {
  await withRouteKitHome(async () => {
    const path = nativeIntegrationsPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        integrations: [
          {
            installVersion: 2,
            managedByVersion: "99.0.0",
            tool: "codex",
            configPath: "/tmp/future/config.toml",
            target: { kind: "local" },
            tokenId: "0123456789abcdef"
          }
        ]
      })
    );
    assert.throws(
      () => getNativeIntegration("codex", "/tmp/future/config.toml"),
      /unsupported native client integration registry install version 2/
    );
  });
});

test("native integration registry rejects malformed or secret-bearing metadata", async () => {
  await withRouteKitHome(async () => {
    const path = nativeIntegrationsPath();
    const directory = join(path, "..");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        integrations: [
          {
            tool: "codex",
            configPath: "/tmp/config.toml",
            target: { kind: "local" },
            tokenId: "0123456789abcdef",
            token: "plaintext-token"
          }
        ]
      })
    );
    assert.equal(existsSync(path), true);
    assert.throws(() => getNativeIntegration("codex", "/tmp/config.toml"), /registry is corrupt/);
  });
});
