import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SERVICE_HOME_MODE } from "@velum-labs/routekit-runtime";

import { notifyIfUpdateAvailable } from "../update-notifier.js";

/**
 * Peer accounts reach the owner's discovery record by traversing
 * `$ROUTEKIT_HOME`, so any writer that hardens the home back to 0700 silently
 * breaks every peer. The update check only writes on an interactive TTY, which
 * is why this regressed without any non-interactive test noticing.
 */
test("the interactive update check keeps the RouteKit home traversable", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-home-mode-"));
  const home = join(root, "state");
  mkdirSync(home, { recursive: true });
  chmodSync(home, SERVICE_HOME_MODE);
  const previous = {
    routekitHome: process.env.ROUTEKIT_HOME,
    noUpdateCheck: process.env.ROUTEKIT_NO_UPDATE_CHECK,
    noTui: process.env.ROUTEKIT_NO_TUI,
    ci: process.env.CI,
    continuousIntegration: process.env.CONTINUOUS_INTEGRATION,
    githubActions: process.env.GITHUB_ACTIONS,
    isTTY: process.stderr.isTTY,
    fetch: globalThis.fetch
  };
  process.env.ROUTEKIT_HOME = home;
  delete process.env.ROUTEKIT_NO_UPDATE_CHECK;
  delete process.env.ROUTEKIT_NO_TUI;
  delete process.env.CI;
  delete process.env.CONTINUOUS_INTEGRATION;
  delete process.env.GITHUB_ACTIONS;
  process.stderr.isTTY = true;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ version: "0.0.1" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    await notifyIfUpdateAvailable("0.11.0");
    await notifyIfUpdateAvailable("0.11.0");
    assert.equal(statSync(home).mode & 0o777, SERVICE_HOME_MODE);
    assert.equal(fetchCalls, 1, "a successful update check should be cached for one day");
  } finally {
    globalThis.fetch = previous.fetch;
    process.stderr.isTTY = previous.isTTY;
    for (const [name, value] of Object.entries({
      ROUTEKIT_HOME: previous.routekitHome,
      ROUTEKIT_NO_UPDATE_CHECK: previous.noUpdateCheck,
      ROUTEKIT_NO_TUI: previous.noTui,
      CI: previous.ci,
      CONTINUOUS_INTEGRATION: previous.continuousIntegration,
      GITHUB_ACTIONS: previous.githubActions
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
