import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXACT_VERSION = /^[0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z.-]+)?$/;
const CLIENT_STATUSES = new Set(["supported", "candidate", "not-offered"]);
const QUALIFICATION_MODES = new Set([
  "automated-ci",
  "automated-ci-plus-live",
  "manual-desktop",
  "excluded"
]);
const FORBIDDEN_SUPPORTED_CLIENTS = new Set(["cursor-agent", "opencode"]);

export function loadSupportedClients(root) {
  return JSON.parse(
    readFileSync(join(root, "spec", "routekit", "supported-clients.json"), "utf8")
  );
}

export function loadLaunchToolIds(root) {
  const source = readFileSync(join(root, "packages", "cli", "src", "launch-support.ts"), "utf8");
  const match = source.match(
    /export const LAUNCH_TOOL_IDS\s*=\s*\[([\s\S]*?)\]\s*as const;/
  );
  assert.ok(match, "could not read LAUNCH_TOOL_IDS from launch-support.ts");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function exactVersion(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, EXACT_VERSION, `${label} must be an exact version`);
  assert.notEqual(value.toLowerCase(), "latest", `${label} must not use latest`);
  return value;
}

function validateEvidence(version, client, label) {
  if (client.status === "supported") {
    assert.match(
      version.qualificationDate ?? "",
      /^20\d{2}-\d{2}-\d{2}$/,
      `${label} must have a qualification date`
    );
    assert.ok(
      Array.isArray(version.evidence) && version.evidence.length > 0,
      `${label} must have evidence`
    );
  } else if (client.status === "candidate") {
    assert.ok(
      version.qualificationDate === null ||
        /^20\d{2}-\d{2}-\d{2}$/.test(version.qualificationDate),
      `${label} has an invalid qualification date`
    );
    assert.ok(Array.isArray(version.evidence), `${label} evidence must be an array`);
  }
  for (const reference of version.evidence ?? []) {
    assert.ok(
      typeof reference === "string" && reference.trim().length > 0,
      `${label} has an empty evidence reference`
    );
  }
}

export function validateSupportedClients(manifest, launchToolIds) {
  assert.equal(manifest.schemaVersion, 1, "unsupported client-support schema");
  assert.equal(manifest.policy, "exact-tested-only", "unsupported client-support policy");
  assert.ok(
    typeof manifest.description === "string" && manifest.description.length > 0,
    "client-support description is required"
  );
  assert.ok(Array.isArray(manifest.clients), "client-support clients must be an array");

  const clientIds = new Set();
  const launchEntries = new Map();
  for (const client of manifest.clients) {
    assert.ok(
      typeof client.id === "string" && /^[a-z][a-z0-9-]*$/.test(client.id),
      "client id is invalid"
    );
    assert.ok(!clientIds.has(client.id), `duplicate client id ${client.id}`);
    clientIds.add(client.id);
    assert.ok(CLIENT_STATUSES.has(client.status), `${client.id} has invalid status`);
    assert.ok(
      QUALIFICATION_MODES.has(client.qualificationMode),
      `${client.id} has invalid qualification mode`
    );
    assert.ok(
      typeof client.displayName === "string" && client.displayName.length > 0,
      `${client.id} is missing displayName`
    );
    assert.ok(
      typeof client.surface === "string" && client.surface.length > 0,
      `${client.id} is missing surface`
    );
    assert.ok(
      typeof client.binary === "string" && client.binary.length > 0,
      `${client.id} is missing binary`
    );
    assert.ok(Array.isArray(client.versions), `${client.id} versions must be an array`);

    if (FORBIDDEN_SUPPORTED_CLIENTS.has(client.id)) {
      assert.equal(client.status, "not-offered", `${client.id} must remain not-offered`);
    }
    if (client.id === "cursor" && client.status === "supported") {
      assert.equal(
        client.qualificationMode,
        "manual-desktop",
        "Cursor support requires manual desktop qualification"
      );
    }
    if (client.status === "not-offered") {
      assert.equal(client.versions.length, 0, `${client.id} must not list supported versions`);
      assert.equal(client.qualificationMode, "excluded", `${client.id} must be excluded`);
      assert.equal(
        client.launchToolId,
        undefined,
        `${client.id} must not declare a public launch tool`
      );
    } else {
      assert.ok(client.versions.length > 0, `${client.id} must list an exact version`);
      assert.notEqual(
        client.qualificationMode,
        "excluded",
        `${client.id} must have a qualification mode`
      );
    }
    for (const reference of client.evidence ?? []) {
      assert.ok(
        typeof reference === "string" && reference.trim().length > 0,
        `${client.id} has an empty evidence reference`
      );
    }

    const versions = new Set();
    for (const version of client.versions) {
      const value = exactVersion(version.version, `${client.id} version`);
      assert.ok(!versions.has(value), `${client.id} has duplicate version ${value}`);
      versions.add(value);
      validateEvidence(version, client, `${client.id} ${value}`);
    }

    if (client.ciVersion !== undefined) {
      exactVersion(client.ciVersion, `${client.id} ciVersion`);
      assert.ok(
        versions.has(client.ciVersion),
        `${client.id} ciVersion must be one of its exact versions`
      );
      assert.equal(typeof client.package, "string", `${client.id} CI package is required`);
      assert.equal(typeof client.binary, "string", `${client.id} CI binary is required`);
      assert.equal(
        typeof client.versionOutputPattern,
        "string",
        `${client.id} version output pattern is required`
      );
      assert.doesNotThrow(
        () => new RegExp(client.versionOutputPattern),
        `${client.id} version output pattern is invalid`
      );
    }
    if (
      client.qualificationMode === "automated-ci" ||
      client.qualificationMode === "automated-ci-plus-live"
    ) {
      assert.equal(
        typeof client.ciVersion,
        "string",
        `${client.id} automated qualification requires ciVersion`
      );
    }
    if (client.id === "cursor" && client.status === "supported") {
      assert.ok(
        client.versions.some((version) =>
          version.evidence.some((reference) =>
            /^docs\/evidence\/client-compatibility\/.*cursor.*\.md$/.test(reference)
          )
        ),
        "Cursor support requires committed manual desktop evidence"
      );
    }

    if (client.launchToolId !== undefined) {
      assert.ok(
        launchToolIds.includes(client.launchToolId),
        `${client.id} references unknown launch tool ${client.launchToolId}`
      );
      assert.ok(
        !launchEntries.has(client.launchToolId),
        `duplicate launch tool entry ${client.launchToolId}`
      );
      launchEntries.set(client.launchToolId, client);
    }
    if (client.status === "supported") {
      assert.equal(
        typeof client.launchToolId,
        "string",
        `${client.id} is supported but missing launchToolId`
      );
    }
  }

  assert.deepEqual(
    [...launchEntries.keys()].sort(),
    [...launchToolIds].sort(),
    "client-support entries must exactly cover LAUNCH_TOOL_IDS"
  );
  for (const toolId of launchToolIds) {
    assert.equal(
      launchEntries.get(toolId)?.status,
      "supported",
      `${toolId} is public but not supported`
    );
  }

  assert.ok(
    Array.isArray(manifest.internalDependencies),
    "internalDependencies must be an array"
  );
  const internalIds = new Set();
  for (const dependency of manifest.internalDependencies) {
    assert.ok(!internalIds.has(dependency.id), `duplicate internal dependency ${dependency.id}`);
    internalIds.add(dependency.id);
    exactVersion(dependency.version, `${dependency.id} internal version`);
    assert.ok(
      typeof dependency.source === "string" && dependency.source.length > 0,
      `${dependency.id} internal source is required`
    );
  }
  assert.ok(internalIds.has("cliproxyapi"), "CLIProxyAPI internal pin is required");
  return manifest;
}

export function ciClients(manifest) {
  return manifest.clients.filter((client) => client.ciVersion !== undefined);
}

export function nativeClientInstallationPlan(manifest) {
  const clients = ciClients(manifest);
  return {
    packages: clients.map((client) => `${client.package}@${client.ciVersion}`),
    allowScripts: clients.map((client) => client.package),
    clients: clients.map((client) => ({
      id: client.id,
      binary: client.binary,
      version: client.ciVersion,
      versionOutputPattern: client.versionOutputPattern
    }))
  };
}

export function observedVersionMatches(client, output) {
  return new RegExp(client.versionOutputPattern).test(String(output).trim());
}

function statusLabel(status) {
  return {
    supported: "Supported",
    candidate: "Candidate — qualification required",
    "not-offered": "Not offered"
  }[status];
}

function evidenceLinks(version, publicDocs) {
  if (version.evidence.length === 0) return "Qualification pending";
  return version.evidence
    .map((reference) => {
      const href = publicDocs
        ? `https://github.com/velum-labs/routekit/blob/main/${reference}`
        : reference.startsWith("docs/")
          ? reference.slice("docs/".length)
          : `../${reference}`;
      return `[${reference}](${href})`;
    })
    .join("<br />");
}

export function renderSupportedClients(manifest, { publicDocs = false } = {}) {
  const lines = [];
  if (publicDocs) {
    lines.push(
      "---",
      'title: "Supported coding tool versions"',
      'description: "Exact client builds qualified with RouteKit."',
      "---",
      ""
    );
  } else {
    lines.push(
      "<!-- Generated by scripts/generate-routekit-client-support.mjs. Do not edit. -->",
      "",
      "# RouteKit client compatibility",
      ""
    );
  }
  lines.push(
    "RouteKit uses an **exact-tested-builds-only** support policy. Only the builds",
    "listed as Supported below are qualified. Older or newer versions are",
    "unqualified, not necessarily incompatible, and must be requalified before",
    "they are added to the support contract.",
    "",
    "This policy does not imply unlimited provider usage or stability across",
    "provider-policy changes. RouteKit does not reject other client versions at",
    "runtime.",
    "",
    "| Client surface | Status | Exact version | Qualification date | Evidence |",
    "| --- | --- | --- | --- | --- |"
  );
  for (const client of manifest.clients) {
    if (client.versions.length === 0) {
      const evidence =
        client.evidence?.length > 0
          ? `${evidenceLinks({ evidence: client.evidence }, publicDocs)}<br />${client.notes}`
          : client.notes;
      lines.push(
        `| ${client.displayName} | ${statusLabel(client.status)} | — | — | ${evidence} |`
      );
      continue;
    }
    for (const [index, version] of client.versions.entries()) {
      lines.push(
        `| ${index === 0 ? client.displayName : "↳"} | ${index === 0 ? statusLabel(client.status) : "↳"} | \`${version.version}\` | ${version.qualificationDate ?? "Pending"} | ${evidenceLinks(version, publicDocs)} |`
      );
    }
  }
  lines.push(
    "",
    "## What compatibility covers",
    "",
    "- Cursor Desktop 3.12.30 is not offered because its custom OpenAI endpoint",
    "  rejected RouteKit model names before sending a gateway request. The",
    "  retained `/v1/cursor` adapter is internal compatibility surface, not a",
    "  current client-support claim.",
    "- The `cursor-agent` CLI uses Cursor's own backend/ACP protocol and is not a",
    "  RouteKit gateway client.",
    "- OpenCode is implemented internally but is not part of the first-launch",
    "  public support contract.",
    "- CLIProxyAPI is an internal connector dependency pinned to `7.2.72`; that",
    "  implementation pin is not a supported-client promise.",
    "- `@openai/codex-sdk@0.145.0` and the Codex discovery `clientVersion` are",
    "  independent dependency/wire pins, not client-support declarations.",
    "",
    "## Requalify a client version",
    "",
    "A client version can be added only after its applicable automated or manual",
    "qualification passes and sanitized evidence is committed. A failing",
    "qualification must not be converted into a support claim through a waiver."
  );
  return `${lines.join("\n")}\n`;
}
