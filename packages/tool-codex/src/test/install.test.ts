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
      profiles: [
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
      profiles: [{ modelId: "opaque-primary" }],
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

test("Codex's single persistent profile can use a safe custom selector", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-codex-opaque-"));
  try {
    const result = installCodexIntegration({
      gatewayUrl: "http://127.0.0.1:9999",
      owner: OWNER,
      profiles: [{ modelId: "provider/model", profileId: "route-1" }],
      codexHome: home
    });
    assert.deepEqual(result.profiles, ["route-1"]);
    assert.match(readFileSync(join(home, "route-1.config.toml"), "utf8"), /provider\/model/);
    assert.equal(existsSync(join(home, "provider", "model.config.toml")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex reinstall migrates a legacy per-model installation to one RouteKit profile", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-codex-migrate-"));
  const configPath = join(home, "config.toml");
  const legacyProfiles = ["routekit-model-1.config.toml", "routekit-model-2.config.toml"];
  writeFileSync(
    configPath,
    [
      'model = "user-default"',
      "",
      "# >>> example-host integration >>>",
      "# example-host-profile-files: routekit-model-1.config.toml routekit-model-2.config.toml",
      "# example-host-catalog-file: .example-host-model-catalog.json",
      "",
      "[model_providers.example_route]",
      'name = "Example Host gateway"',
      'base_url = "http://127.0.0.1:9999/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      'env_key = "ROUTEKIT_GATEWAY_TOKEN"',
      "",
      "# <<< example-host integration <<<",
      ""
    ].join("\n")
  );
  for (const profile of legacyProfiles) {
    writeFileSync(join(home, profile), "# Managed by example-host\nmodel = \"opaque-primary\"\n");
  }
  writeFileSync(join(home, ".example-host-model-catalog.json"), "{\"models\":[]}\n");
  try {
    const result = installCodexIntegration({
      gatewayUrl: "http://127.0.0.1:8888",
      owner: OWNER,
      profiles: [{ modelId: "opaque-primary" }, { modelId: "opaque-secondary" }],
      defaultModel: "opaque-secondary",
      codexHome: home
    });
    assert.equal(result.action, "updated");
    assert.deepEqual(result.profiles, ["routekit"]);
    assert.equal(existsSync(join(home, "routekit.config.toml")), true);
    for (const profile of legacyProfiles) assert.equal(existsSync(join(home, profile)), false);
    assert.match(readFileSync(configPath, "utf8"), /example-host-profile-files: routekit\.config\.toml/);
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
          profiles: [{ modelId: "opaque-primary" }],
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
