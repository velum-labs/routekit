import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installNativeEvalSkill, uninstallNativeEvalSkill } from "../adapters/native-eval-skill.js";

test("native client installs own the eval setup skill without touching other skills", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-native-eval-skill-"));
  const configPath = join(home, "config.toml");
  const otherSkill = join(home, "skills", "user-skill", "SKILL.md");
  try {
    const skillPath = installNativeEvalSkill(configPath);
    assert.equal(skillPath, join(home, "skills", "setup-eval-routing", "SKILL.md"));
    assert.match(readFileSync(skillPath, "utf8"), /name: setup-eval-routing/);

    const ownershipPath = join(home, "skills", "setup-eval-routing", ".routekit-install.json");
    assert.equal(existsSync(ownershipPath), true);

    mkdirSync(join(home, "skills", "user-skill"), { recursive: true });
    writeFileSync(otherSkill, "user-owned\n");
    installNativeEvalSkill(configPath);
    uninstallNativeEvalSkill(configPath);

    assert.equal(existsSync(skillPath), false);
    assert.equal(existsSync(ownershipPath), false);
    assert.equal(readFileSync(otherSkill, "utf8"), "user-owned\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("native client install refuses to overwrite an unowned skill", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-native-eval-skill-conflict-"));
  const skillPath = join(home, "skills", "setup-eval-routing", "SKILL.md");
  try {
    mkdirSync(join(home, "skills", "setup-eval-routing"), { recursive: true });
    writeFileSync(skillPath, "user-owned\n");
    assert.throws(
      () => installNativeEvalSkill(join(home, "settings.json")),
      /refusing to overwrite an existing setup-eval-routing skill/
    );
    assert.equal(readFileSync(skillPath, "utf8"), "user-owned\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("native client uninstall preserves a modified managed skill", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-native-eval-skill-modified-"));
  const configPath = join(home, "settings.json");
  try {
    const skillPath = installNativeEvalSkill(configPath);
    writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}\nuser edit\n`);

    assert.throws(
      () => installNativeEvalSkill(configPath),
      /RouteKit-managed setup-eval-routing skill was edited/
    );
    uninstallNativeEvalSkill(configPath);

    assert.match(readFileSync(skillPath, "utf8"), /user edit/);
    assert.equal(
      existsSync(join(home, "skills", "setup-eval-routing", ".routekit-install.json")),
      false
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
