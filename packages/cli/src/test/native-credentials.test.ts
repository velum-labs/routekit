import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  nativeCredentialHelper,
  nativeCredentialShellCommand
} from "../native-credential-helper.js";
import {
  deleteNativeCredential,
  nativeCredentialPath,
  readNativeCredential,
  writeNativeCredential
} from "../native-credentials.js";

test("native credentials use a private file fallback and clean up", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-native-credential-"));
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = root;
  try {
    const configPath = join(root, "codex", "config.toml");
    const options = { platform: "linux" as const };
    await writeNativeCredential("codex", configPath, "rk1_private", options);
    const path = nativeCredentialPath("codex", configPath);
    assert.equal(readFileSync(path, "utf8"), "rk1_private\n");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(await readNativeCredential("codex", configPath, options), "rk1_private");
    await deleteNativeCredential("codex", configPath, options);
    assert.equal(existsSync(path), false);
    assert.equal(await readNativeCredential("codex", configPath, options), undefined);
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native credentials use Keychain when available", async () => {
  const calls: string[][] = [];
  let stored = "";
  const runKeychain = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "add-generic-password") {
      stored = args.at(-1) ?? "";
      return "";
    }
    if (args[0] === "find-generic-password") return stored;
    stored = "";
    return "";
  };
  await writeNativeCredential("claude", "/tmp/claude/settings.json", "rk1_keychain", {
    platform: "darwin",
    runKeychain
  });
  assert.equal(
    await readNativeCredential("claude", "/tmp/claude/settings.json", {
      platform: "darwin",
      runKeychain
    }),
    "rk1_keychain"
  );
  await deleteNativeCredential("claude", "/tmp/claude/settings.json", {
    platform: "darwin",
    runKeychain
  });
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["add-generic-password", "find-generic-password", "delete-generic-password"]
  );
});

test("the current OS credential backend stores, reads, and removes a real credential", {
  skip: process.env.ROUTEKIT_NATIVE_CREDENTIAL_E2E !== "1"
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-native-platform-credential-"));
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = root;
  const configPath = join(root, "native client", "config.json");
  const token = `rk1_platform_${process.pid}_${Date.now()}`;
  try {
    await writeNativeCredential("claude", configPath, token);
    const fallback = nativeCredentialPath("claude", configPath);
    assert.equal(
      existsSync(fallback),
      process.platform !== "darwin",
      process.platform === "darwin"
        ? "macOS must use the runner's real login Keychain"
        : "non-macOS hosts must use the private credential file"
    );
    assert.equal(
      (await readNativeCredential("claude", configPath)) === token,
      true,
      "the selected OS credential backend must return the stored value"
    );
    await deleteNativeCredential("claude", configPath);
    assert.equal(await readNativeCredential("claude", configPath), undefined);
  } finally {
    await deleteNativeCredential("claude", configPath).catch(() => undefined);
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native credential helpers are absolute, config-specific, and PATH-independent", () => {
  const helper = nativeCredentialHelper("codex", "/tmp/custom codex/config.toml", {
    cliEntrypoint: "/opt/routekit/bin/routekit",
    execPath: "/opt/routekit/bin/node"
  });
  assert.equal(helper.command, "/opt/routekit/bin/node");
  assert.equal(helper.args[0], "/opt/routekit/bin/routekit");
  assert.deepEqual(helper.args.slice(3, 7), [
    "--tool",
    "codex",
    "--config-path",
    "/tmp/custom codex/config.toml"
  ]);
  const shellCommand = nativeCredentialShellCommand(helper, "linux");
  assert.match(shellCommand, /credential get/);
  assert.ok(shellCommand.includes("'/tmp/custom codex/config.toml'"));
  assert.throws(() => nativeCredentialShellCommand(helper, "win32"), /not supported on Windows/);
});
