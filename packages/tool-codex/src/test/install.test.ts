import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  installCodexIntegration,
  uninstallCodexIntegration
} from "../install.js";
import type { CodexInstallOwner } from "../install.js";

const OWNER: CodexInstallOwner = {
  id: "example-host",
  displayName: "Example Host",
  providerId: "example_route",
  installCommand: "example install codex",
  uninstallCommand: "example uninstall codex",
  startCommand: "example serve"
};

test("Codex managed install adds one picker-backed profile and removes only owner-marked config", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-codex-install-"));
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, 'model = "user-default"\n');
  try {
    const installed = installCodexIntegration({
      gatewayUrl: "http://127.0.0.1:9999/",
      owner: OWNER,
      models: [
        { modelId: "opaque-primary" },
        { modelId: "opaque-secondary", description: "Secondary route" }
      ],
      defaultModel: "opaque-secondary",
      codexHome: home
    });
    assert.equal(installed.action, "installed");
    assert.deepEqual(installed.profiles, ["routekit"]);
    assert.match(readFileSync(configPath, "utf8"), /model = "user-default"/);
    assert.match(readFileSync(configPath, "utf8"), /base_url = "http:\/\/127\.0\.0\.1:9999\/v1"/);
    assert.match(readFileSync(configPath, "utf8"), /codex --profile routekit/);
    assert.equal(existsSync(join(home, "routekit.config.toml")), true);
    assert.equal(existsSync(join(home, "opaque-primary.config.toml")), false);
    assert.equal(existsSync(join(home, "opaque-secondary.config.toml")), false);
    assert.equal(existsSync(installed.catalogPath), true);
    assert.match(
      readFileSync(join(home, "routekit.config.toml"), "utf8"),
      /model = "opaque-secondary"/
    );
    assert.match(
      readFileSync(join(home, "routekit.config.toml"), "utf8"),
      /model_catalog_json/
    );
    assert.deepEqual(
      JSON.parse(readFileSync(installed.catalogPath, "utf8")).models.map(
        (model: { slug: string }) => model.slug
      ),
      ["opaque-secondary", "opaque-primary"]
    );

    const updated = installCodexIntegration({
      gatewayUrl: "http://127.0.0.1:8888",
      owner: OWNER,
      models: [{ modelId: "opaque-primary" }],
      defaultModel: "opaque-primary",
      codexHome: home
    });
    assert.equal(updated.action, "updated");
    assert.deepEqual(updated.profiles, ["routekit"]);
    assert.match(readFileSync(join(home, "routekit.config.toml"), "utf8"), /model = "opaque-primary"/);

    assert.equal(uninstallCodexIntegration({ ownerId: OWNER.id, codexHome: home }).removed, true);
    assert.equal(readFileSync(configPath, "utf8"), 'model = "user-default"\n');
    assert.equal(existsSync(join(home, "routekit.config.toml")), false);
    assert.equal(existsSync(installed.catalogPath), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex managed install can use a command-backed bearer token", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-codex-auth-helper-"));
  try {
    installCodexIntegration({
      gatewayUrl: "http://127.0.0.1:9999",
      owner: OWNER,
      models: [{ modelId: "opaque-primary" }],
      auth: {
        command: "/opt/routekit/node",
        args: ["/opt/routekit/index.js", "credential", "get", "--tool", "codex"]
      },
      codexHome: home
    });
    const config = readFileSync(join(home, "config.toml"), "utf8");
    assert.match(config, /\[model_providers\.example_route\.auth\]/);
    assert.match(config, /command = "\/opt\/routekit\/node"/);
    assert.match(config, /"credential", "get", "--tool", "codex"/);
    assert.doesNotMatch(config, /env_key|requires_openai_auth/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex's single persistent profile can use a safe custom selector", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-codex-opaque-"));
  try {
    const result = installCodexIntegration({
      gatewayUrl: "http://127.0.0.1:9999",
      owner: OWNER,
      models: [{ modelId: "provider/model" }],
      profileId: "route-1",
      codexHome: home
    });
    assert.deepEqual(result.profiles, ["route-1"]);
    assert.match(readFileSync(join(home, "route-1.config.toml"), "utf8"), /provider\/model/);
    assert.equal(existsSync(join(home, "provider", "model.config.toml")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex install refuses to overwrite a user-owned routekit profile", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-codex-profile-conflict-"));
  const configPath = join(home, "config.toml");
  writeFileSync(join(home, "routekit.config.toml"), 'model = "user-profile"\n');
  try {
    assert.throws(
      () =>
        installCodexIntegration({
          gatewayUrl: "http://127.0.0.1:9999",
          owner: OWNER,
          models: [{ modelId: "opaque-primary" }],
          codexHome: home
        }),
      /refusing to overwrite an existing Codex profile/
    );
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(join(home, ".example-host-model-catalog.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
