import assert from "node:assert/strict";
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import {
  browserOpenerStubDirectory,
  captureLoginCredential,
  type ManagedAccountLoginInvocation,
  parseAccountMode
} from "../index.js";

test("subscription mode accepts only canonical account identifiers", () => {
  assert.equal(parseAccountMode("claude-code"), "claude-code");
  assert.equal(parseAccountMode("codex"), "codex");
  assert.throws(() => parseAccountMode("claude"), /must be claude-code or codex/);
  assert.throws(() => parseAccountMode("claudeCode"), /must be claude-code or codex/);
});

test("claude-code --no-browser shadows open/xdg-open and sets BROWSER", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-claude-nobrowser-"));
  const stateHome = join(root, "state");
  const previousStateHome = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = stateHome;
  try {
    let seen: ManagedAccountLoginInvocation | undefined;
    await captureLoginCredential("claude-code", "headless", {
      temporaryParent: root,
      noBrowser: true,
      runLogin: async (invocation) => {
        seen = invocation;
        const stubBin = browserOpenerStubDirectory(invocation.profileDirectory);
        assert.equal(invocation.command, "claude");
        assert.deepEqual(invocation.args, ["auth", "login", "--claudeai"]);
        assert.equal(invocation.env.BROWSER, "/usr/bin/false");
        assert.ok(
          invocation.env.PATH?.startsWith(`${stubBin}${delimiter}`),
          `PATH should start with stub bin; got ${invocation.env.PATH}`
        );
        for (const name of ["open", "xdg-open"] as const) {
          const stubPath = join(stubBin, name);
          accessSync(stubPath, constants.X_OK);
        }
        writeFileSync(
          invocation.sourcePath,
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "nobrowser-claude",
              refreshToken: "nobrowser-refresh",
              expiresAt: Date.now() + 3_600_000
            }
          })
        );
        return 0;
      }
    });
    assert.ok(seen);
  } finally {
    if (previousStateHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousStateHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude-code without --no-browser leaves PATH and BROWSER alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-claude-browser-"));
  const stateHome = join(root, "state");
  const previousStateHome = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = stateHome;
  try {
    await captureLoginCredential("claude-code", "desktop", {
      temporaryParent: root,
      runLogin: async (invocation) => {
        const stubBin = browserOpenerStubDirectory(invocation.profileDirectory);
        assert.equal(invocation.env.BROWSER, undefined);
        assert.equal(
          invocation.env.PATH?.startsWith(`${stubBin}${delimiter}`) ?? false,
          false
        );
        writeFileSync(
          invocation.sourcePath,
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "browser-claude",
              refreshToken: "browser-refresh",
              expiresAt: Date.now() + 3_600_000
            }
          })
        );
        return 0;
      }
    });
  } finally {
    if (previousStateHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousStateHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex --no-browser still uses --device-auth and does not install browser stubs", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-codex-nobrowser-"));
  const stateHome = join(root, "state");
  const previousStateHome = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = stateHome;
  try {
    await captureLoginCredential("codex", "device", {
      temporaryParent: root,
      noBrowser: true,
      runLogin: async (invocation) => {
        assert.equal(invocation.command, "codex");
        assert.deepEqual(invocation.args, ["login", "--device-auth"]);
        assert.equal(invocation.env.BROWSER, undefined);
        const stubBin = browserOpenerStubDirectory(invocation.profileDirectory);
        assert.equal(
          invocation.env.PATH?.startsWith(`${stubBin}${delimiter}`) ?? false,
          false
        );
        writeFileSync(
          invocation.sourcePath,
          JSON.stringify({
            tokens: {
              access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.",
              refresh_token: "device-refresh",
              account_id: "acct-device"
            }
          })
        );
        return 0;
      }
    });
  } finally {
    if (previousStateHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousStateHome;
    rmSync(root, { recursive: true, force: true });
  }
});
