import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installNativeRouteKitSkill,
  uninstallNativeRouteKitSkill
} from "../adapters/native-routekit-skill.js";

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeLegacySkill(
  home: string,
  content: string,
  options: { installedContent?: string } = {}
): void {
  const directory = join(home, "skills", "setup-eval-routing");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), content);
  writeFileSync(
    join(directory, ".routekit-install.json"),
    `${JSON.stringify(
      {
        version: 1,
        owner: "routekit",
        skill: "setup-eval-routing",
        contentHash: hash(options.installedContent ?? content)
      },
      null,
      2
    )}\n`
  );
}

test("native client installs the complete RouteKit skill without touching other skills", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-native-skill-"));
  const configPath = join(home, "config.toml");
  const otherSkill = join(home, "skills", "user-skill", "SKILL.md");
  try {
    const result = installNativeRouteKitSkill(configPath);
    assert.equal(result.skillPath, join(home, "skills", "routekit", "SKILL.md"));
    assert.equal(result.legacySkill, "absent");
    assert.match(readFileSync(result.skillPath, "utf8"), /name: routekit/u);
    assert.equal(
      existsSync(join(home, "skills", "routekit", "references", "eval-routing.md")),
      true
    );
    assert.equal(existsSync(join(home, "skills", "routekit", "agents", "openai.yaml")), true);

    const ownershipPath = join(home, "skills", "routekit", ".routekit-install.json");
    const ownership = JSON.parse(readFileSync(ownershipPath, "utf8")) as {
      version: number;
      files: Record<string, string>;
    };
    assert.equal(ownership.version, 2);
    assert.ok(ownership.files["SKILL.md"]);
    assert.ok(ownership.files["references/eval-routing.md"]);

    mkdirSync(join(home, "skills", "user-skill"), { recursive: true });
    writeFileSync(otherSkill, "user-owned\n");
    installNativeRouteKitSkill(configPath);
    uninstallNativeRouteKitSkill(configPath);

    assert.equal(existsSync(result.skillPath), false);
    assert.equal(existsSync(ownershipPath), false);
    assert.equal(readFileSync(otherSkill, "utf8"), "user-owned\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("native client install refuses to overwrite an unowned RouteKit skill", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-native-skill-conflict-"));
  const skillPath = join(home, "skills", "routekit", "SKILL.md");
  try {
    mkdirSync(join(home, "skills", "routekit"), { recursive: true });
    writeFileSync(skillPath, "user-owned\n");
    assert.throws(
      () => installNativeRouteKitSkill(join(home, "settings.json")),
      /refusing to overwrite an existing routekit skill/
    );
    assert.equal(readFileSync(skillPath, "utf8"), "user-owned\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("native client uninstall preserves modified managed RouteKit skill files", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-native-skill-modified-"));
  const configPath = join(home, "settings.json");
  try {
    const { skillPath } = installNativeRouteKitSkill(configPath);
    writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}\nuser edit\n`);

    assert.throws(
      () => installNativeRouteKitSkill(configPath),
      /RouteKit-managed routekit skill was edited/
    );
    uninstallNativeRouteKitSkill(configPath);

    assert.match(readFileSync(skillPath, "utf8"), /user edit/u);
    assert.equal(existsSync(join(home, "skills", "routekit", ".routekit-install.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install migrates an unchanged managed setup-eval-routing skill", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-native-skill-migration-"));
  const configPath = join(home, "config.toml");
  try {
    writeLegacySkill(home, "legacy managed skill\n");
    const result = installNativeRouteKitSkill(configPath);

    assert.equal(result.legacySkill, "removed");
    assert.equal(existsSync(join(home, "skills", "setup-eval-routing")), false);
    assert.equal(existsSync(result.skillPath), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install preserves an edited legacy skill and relinquishes its ownership", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-native-skill-legacy-edit-"));
  const configPath = join(home, "settings.json");
  const legacyDirectory = join(home, "skills", "setup-eval-routing");
  try {
    writeLegacySkill(home, "legacy skill with user edits\n", {
      installedContent: "legacy managed skill\n"
    });
    const result = installNativeRouteKitSkill(configPath);

    assert.equal(result.legacySkill, "preserved");
    assert.equal(
      readFileSync(join(legacyDirectory, "SKILL.md"), "utf8"),
      "legacy skill with user edits\n"
    );
    assert.equal(existsSync(join(legacyDirectory, ".routekit-install.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install preserves a legacy skill with unowned companion files", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-native-skill-legacy-companion-"));
  const configPath = join(home, "settings.json");
  const legacyDirectory = join(home, "skills", "setup-eval-routing");
  const companionPath = join(legacyDirectory, "notes.md");
  try {
    writeLegacySkill(home, "legacy managed skill\n");
    writeFileSync(companionPath, "user-owned companion\n");
    const result = installNativeRouteKitSkill(configPath);

    assert.equal(result.legacySkill, "preserved");
    assert.equal(
      readFileSync(join(legacyDirectory, "SKILL.md"), "utf8"),
      "legacy managed skill\n"
    );
    assert.equal(readFileSync(companionPath, "utf8"), "user-owned companion\n");
    assert.equal(existsSync(join(legacyDirectory, ".routekit-install.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
