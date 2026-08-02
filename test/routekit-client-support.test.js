import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  loadLaunchToolIds,
  loadSupportedClients,
  nativeClientInstallationPlan,
  observedVersionMatches,
  renderSupportedClients,
  validateSupportedClients
} from "../scripts/lib/routekit-client-support.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const launchToolIds = loadLaunchToolIds(ROOT);
const manifest = loadSupportedClients(ROOT);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("supported-client manifest is exact and covers the public launch tools", () => {
  validateSupportedClients(manifest, launchToolIds);
  assert.deepEqual(launchToolIds, ["codex", "claude"]);
  const byId = new Map(manifest.clients.map((client) => [client.id, client]));
  assert.deepEqual(
    byId.get("codex").versions.map((entry) => entry.version),
    ["0.146.0"]
  );
  assert.deepEqual(
    byId.get("claude").versions.map((entry) => entry.version),
    ["2.1.216", "2.1.220"]
  );
  assert.equal(byId.get("cursor").status, "not-offered");
  assert.equal(byId.get("cursor-agent").status, "not-offered");
  assert.equal(byId.get("opencode").status, "not-offered");
});

test("native-client install plan comes only from manifest CI pins", () => {
  const plan = nativeClientInstallationPlan(manifest);
  assert.deepEqual(plan.packages, [
    "@openai/codex@0.146.0",
    "@anthropic-ai/claude-code@2.1.216"
  ]);
  assert.deepEqual(plan.allowScripts, [
    "@openai/codex",
    "@anthropic-ai/claude-code"
  ]);
  assert.equal(
    observedVersionMatches(plan.clients[0], "codex-cli 0.146.0"),
    true
  );
  assert.equal(
    observedVersionMatches(plan.clients[1], "2.1.216 (Claude Code)"),
    true
  );
  assert.equal(
    observedVersionMatches(plan.clients[1], "2.1.220 (Claude Code)"),
    false
  );
});

test("manifest rejects ranges, latest, duplicates, and unsupported claims", () => {
  for (const invalidVersion of ["latest", ">=0.146.0", "^0.146.0"]) {
    const changed = clone(manifest);
    changed.clients[0].versions[0].version = invalidVersion;
    assert.throws(
      () => validateSupportedClients(changed, launchToolIds),
      /exact version/
    );
  }

  const duplicate = clone(manifest);
  duplicate.clients[1].versions.push(clone(duplicate.clients[1].versions[0]));
  assert.throws(
    () => validateSupportedClients(duplicate, launchToolIds),
    /duplicate version/
  );

  const unsupported = clone(manifest);
  unsupported.clients.find((client) => client.id === "opencode").status = "supported";
  assert.throws(
    () => validateSupportedClients(unsupported, launchToolIds),
    /must remain not-offered/
  );

  const missingVersions = clone(manifest);
  missingVersions.clients[0].versions = [];
  assert.throws(
    () => validateSupportedClients(missingVersions, launchToolIds),
    /must list an exact version/
  );
});

test("supported versions require evidence and unqualified clients cannot masquerade as supported", () => {
  const missingEvidence = clone(manifest);
  missingEvidence.clients[0].versions[0].evidence = [];
  assert.throws(
    () => validateSupportedClients(missingEvidence, launchToolIds),
    /must have evidence/
  );

  const cursorWithoutEvidence = clone(manifest);
  const cursor = cursorWithoutEvidence.clients.find((client) => client.id === "cursor");
  cursor.status = "supported";
  cursor.qualificationMode = "manual-desktop";
  cursor.launchToolId = "cursor";
  cursor.versions = [
    {
      version: "3.12.30",
      qualificationDate: "2026-08-01",
      evidence: []
    }
  ];
  assert.throws(
    () => validateSupportedClients(cursorWithoutEvidence, [...launchToolIds, "cursor"]),
    /must have evidence/
  );

  const cursorWithoutManualQualification = clone(cursorWithoutEvidence);
  const nonManualCursor = cursorWithoutManualQualification.clients.find(
    (client) => client.id === "cursor"
  );
  nonManualCursor.qualificationMode = "automated-ci";
  nonManualCursor.versions[0].evidence = [
    "docs/evidence/client-compatibility/2026-08-01-cursor-3.12.30.md"
  ];
  assert.throws(
    () =>
      validateSupportedClients(cursorWithoutManualQualification, [
        ...launchToolIds,
        "cursor"
      ]),
    /manual desktop qualification/
  );

  const cursorWithoutManualEvidence = clone(cursorWithoutEvidence);
  const cursorWithOnlyCiEvidence = cursorWithoutManualEvidence.clients.find(
    (client) => client.id === "cursor"
  );
  cursorWithOnlyCiEvidence.versions[0].evidence = [".github/workflows/ci.yml"];
  assert.throws(
    () =>
      validateSupportedClients(cursorWithoutManualEvidence, [
        ...launchToolIds,
        "cursor"
      ]),
    /committed manual desktop evidence/
  );
});

test("CLIProxyAPI support metadata matches the internal implementation pin", () => {
  const dependency = manifest.internalDependencies.find(
    (entry) => entry.id === "cliproxyapi"
  );
  const source = readFileSync(join(ROOT, dependency.source), "utf8");
  assert.match(
    source,
    new RegExp(
      `CLIPROXY_PINNED_VERSION\\s*=\\s*"${dependency.version.replaceAll(".", "\\.")}"`
    )
  );
});

test("generated documents state the exact-only policy and qualification boundary", () => {
  const maintainer = renderSupportedClients(manifest);
  const publicDocs = renderSupportedClients(manifest, { publicDocs: true });
  const outputs = [
    [maintainer, "docs/routekit-supported-clients.md"],
    [publicDocs, "apps/docs/content/docs/reference/client-compatibility.mdx"]
  ];
  for (const [output, path] of outputs) {
    assert.match(output, /exact-tested-builds-only/);
    assert.match(output, /Codex CLI.*`0\.146\.0`/s);
    assert.match(output, /Claude Code.*`2\.1\.216`.*`2\.1\.220`/s);
    assert.match(output, /Cursor Desktop custom OpenAI endpoint.*Not offered/s);
    assert.match(output, /cursor-agent.*Not offered/s);
    assert.equal(readFileSync(join(ROOT, path), "utf8"), output);
  }
});

test("native-client CI delegates installation and version checks to the manifest installer", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /node scripts\/install-supported-native-clients\.mjs/);
  assert.doesNotMatch(workflow, /@openai\/codex@0\.146\.0/);
  assert.doesNotMatch(workflow, /@anthropic-ai\/claude-code@2\.1\.216/);
});
