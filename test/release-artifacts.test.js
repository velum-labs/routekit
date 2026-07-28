import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReleaseArtifacts, licensePolicy } from "../scripts/lib/release-artifacts.mjs";

const SHA = "a".repeat(40);
const GENERATED_AT = "2026-07-28T16:00:00.000Z";

function pkg(id, name, version, license = "MIT", extra = {}) {
  return {
    SPDXID: id,
    name,
    versionInfo: version,
    downloadLocation: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    filesAnalyzed: false,
    licenseConcluded: license,
    licenseDeclared: license,
    copyrightText: "NOASSERTION",
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:npm/${encodeURIComponent(name)}@${version}`
      }
    ],
    checksums: [{ algorithm: "SHA512", checksumValue: "b".repeat(128) }],
    ...extra
  };
}

function fixture(packages = [], relationships = []) {
  const root = pkg("SPDXRef-RootPackage", "@velum-labs/routekit", "1.2.3", "Apache-2.0");
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "@velum-labs/routekit",
    documentNamespace: "https://example.invalid/original",
    creationInfo: { created: GENERATED_AT, creators: ["Tool: pnpm"] },
    packages: [root, ...packages],
    relationships
  };
}

const depends = (from, to) => ({
  spdxElementId: from,
  relatedSpdxElement: to,
  relationshipType: "DEPENDS_ON"
});

function build(spdx) {
  return buildReleaseArtifacts({
    spdx,
    expectedVersion: "1.2.3",
    sourceSha: SHA,
    generatedAt: GENERATED_AT
  });
}

test("derives sorted third-party inventory with direct and transitive depth", () => {
  const firstParty = pkg("SPDXRef-First", "@velum-labs/routekit-gateway", "1.2.3", "Apache-2.0");
  const direct = pkg("SPDXRef-Z", "z-direct", "2.0.0", "MIT");
  const transitive = pkg("SPDXRef-A", "a-transitive", "3.0.0", "(MIT OR CC0-1.0)");
  const { spdx, inventory } = build(
    fixture(
      [direct, transitive, firstParty],
      [
        depends("SPDXRef-RootPackage", "SPDXRef-Z"),
        depends("SPDXRef-RootPackage", "SPDXRef-First"),
        depends("SPDXRef-Z", "SPDXRef-A")
      ]
    )
  );
  assert.deepEqual(inventory.packages.map((entry) => entry.name), ["a-transitive", "z-direct"]);
  assert.equal(inventory.packages[0].scope, "transitive");
  assert.equal(inventory.packages[0].dependencyDepth, 2);
  assert.equal(inventory.packages[1].scope, "direct");
  assert.equal(inventory.packages[1].dependencyDepth, 1);
  assert.deepEqual(inventory.summary, {
    thirdPartyPackages: 2,
    direct: 1,
    transitive: 1,
    reviewedExceptions: 0,
    byLicense: { "(MIT OR CC0-1.0)": 1, MIT: 1 }
  });
  assert.equal(spdx.creationInfo.created, GENERATED_AT);
  assert.match(spdx.creationInfo.comment, new RegExp(SHA));
  assert.deepEqual(spdx.documentDescribes, ["SPDXRef-RootPackage"]);
});

test("preserves reviewed proprietary package as a visible exception", () => {
  const proprietary = pkg(
    "SPDXRef-Proprietary",
    "@anthropic-ai/claude-agent-sdk-linux-x64",
    "0.3.198",
    "NOASSERTION"
  );
  const { inventory } = build(
    fixture([proprietary], [depends("SPDXRef-RootPackage", proprietary.SPDXID)])
  );
  assert.equal(inventory.packages[0].license, "NOASSERTION");
  assert.equal(inventory.packages[0].policy.status, "reviewed-exception");
  assert.equal(inventory.summary.reviewedExceptions, 1);
});

test("rejects missing, copyleft, and otherwise unapproved licenses", () => {
  for (const [name, license] of [
    ["unknown-package", "NOASSERTION"],
    ["gpl-package", "GPL-3.0-only"],
    ["custom-package", "LicenseRef-Proprietary"]
  ]) {
    const dependency = pkg("SPDXRef-Bad", name, "1.0.0", license);
    assert.throws(
      () => build(fixture([dependency], [depends("SPDXRef-RootPackage", dependency.SPDXID)])),
      new RegExp(name)
    );
  }
});

test("validates source SHA and expected version", () => {
  const dependency = pkg("SPDXRef-Dependency", "dependency", "1.0.0");
  const spdx = fixture([dependency], [depends("SPDXRef-RootPackage", dependency.SPDXID)]);
  assert.throws(
    () =>
      buildReleaseArtifacts({
        spdx,
        expectedVersion: "9.9.9",
        sourceSha: SHA,
        generatedAt: GENERATED_AT
      }),
    /expected version 9\.9\.9, found 1\.2\.3/
  );
  assert.throws(
    () =>
      buildReleaseArtifacts({
        spdx,
        expectedVersion: "1.2.3",
        sourceSha: "short",
        generatedAt: GENERATED_AT
      }),
    /40 hexadecimal/
  );
});

test("license policy accepts approved SPDX OR expressions", () => {
  assert.equal(licensePolicy("example", "1.0.0", "(MIT OR CC0-1.0)").status, "approved");
  assert.equal(licensePolicy("example", "1.0.0", "MIT AND Apache-2.0").status, "approved");
});
