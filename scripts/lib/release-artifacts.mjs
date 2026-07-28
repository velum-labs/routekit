const ROOT_PACKAGE = "@velum-labs/routekit";
const FIRST_PARTY_PREFIX = "@velum-labs/routekit";
const ALLOWED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense"
]);

function assert(condition, message) {
  if (!condition) throw new Error(`release artifacts: ${message}`);
}

function compareText(a, b) {
  return a.localeCompare(b, "en");
}

function packageKey(pkg) {
  return `${pkg.name}@${pkg.versionInfo ?? "NOASSERTION"}`;
}

function isReviewedLicenseException(name, version) {
  return (
    name === "@anthropic-ai/claude-agent-sdk" ||
    name.startsWith("@anthropic-ai/claude-agent-sdk-") ||
    (name === "@openai/codex" && /-(?:darwin|linux|win32)-/u.test(version))
  );
}

function termsInExpression(expression) {
  const normalized = expression.replace(/[()]/g, " ").trim();
  if (normalized.length === 0) return [];
  return normalized.split(/\s+(?:AND|OR|WITH)\s+/u).filter(Boolean);
}

export function licensePolicy(name, version, declaredLicense) {
  const license = declaredLicense ?? "NOASSERTION";
  if (
    license === "NOASSERTION" ||
    license === "NONE" ||
    license.startsWith("SEE LICENSE IN ")
  ) {
    if (isReviewedLicenseException(name, version)) {
      return {
        status: "reviewed-exception",
        reason:
          "Upstream package metadata does not declare an SPDX license and refers to separate/commercial terms or a bundled license file; manual review is required."
      };
    }
    return {
      status: "rejected",
      reason: `missing SPDX license metadata for ${name}@${version}`
    };
  }
  const terms = termsInExpression(license);
  if (terms.length > 0 && terms.every((term) => ALLOWED_LICENSES.has(term))) {
    return { status: "approved", reason: "SPDX license is on the release allowlist." };
  }
  return {
    status: "rejected",
    reason: `license expression ${JSON.stringify(license)} is not on the release allowlist`
  };
}

function purlOf(pkg) {
  return pkg.externalRefs?.find(
    (ref) => ref.referenceCategory === "PACKAGE-MANAGER" && ref.referenceType === "purl"
  )?.referenceLocator;
}

function checksumOf(pkg) {
  return pkg.checksums?.find((checksum) => checksum.algorithm === "SHA512")?.checksumValue;
}

function packageSource(pkg) {
  if (typeof pkg.downloadLocation === "string" && !["NOASSERTION", "NONE"].includes(pkg.downloadLocation)) {
    return pkg.downloadLocation;
  }
  return pkg.homepage && !["NOASSERTION", "NONE"].includes(pkg.homepage)
    ? pkg.homepage
    : undefined;
}

function dependencyDepths(rootId, relationships) {
  const graph = new Map();
  for (const relation of relationships) {
    if (relation.relationshipType !== "DEPENDS_ON") continue;
    const targets = graph.get(relation.spdxElementId) ?? [];
    targets.push(relation.relatedSpdxElement);
    graph.set(relation.spdxElementId, targets);
  }
  const depths = new Map([[rootId, 0]]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    const depth = depths.get(current);
    for (const target of graph.get(current) ?? []) {
      const nextDepth = depth + 1;
      if (depths.has(target) && depths.get(target) <= nextDepth) continue;
      depths.set(target, nextDepth);
      queue.push(target);
    }
  }
  return depths;
}

function validateInputs(spdx, expectedVersion, sourceSha, generatedAt) {
  assert(spdx?.spdxVersion === "SPDX-2.3", "pnpm must produce an SPDX 2.3 document");
  assert(Array.isArray(spdx.packages) && spdx.packages.length > 0, "SPDX packages are empty");
  assert(
    Array.isArray(spdx.relationships) && spdx.relationships.length > 0,
    "SPDX relationships are empty"
  );
  assert(/^[0-9a-f]{40}$/iu.test(sourceSha), "source SHA must be exactly 40 hexadecimal characters");
  assert(!Number.isNaN(Date.parse(generatedAt)), "generated-at must be an ISO-8601 timestamp");
  const root = spdx.packages.find((pkg) => pkg.name === ROOT_PACKAGE);
  assert(root !== undefined, `SPDX root package ${ROOT_PACKAGE} is missing`);
  assert(root.versionInfo === expectedVersion, `expected version ${expectedVersion}, found ${root.versionInfo}`);
  return root;
}

export function buildReleaseArtifacts({
  spdx,
  expectedVersion,
  sourceSha,
  generatedAt,
  repository = "https://github.com/velum-labs/routekit"
}) {
  const root = validateInputs(spdx, expectedVersion, sourceSha, generatedAt);
  const releaseTag = `${ROOT_PACKAGE}@${expectedVersion}`;
  const normalizedSpdx = structuredClone(spdx);
  const wrapperIds = new Set(
    normalizedSpdx.packages
      .filter((pkg) => pkg.name === "routekit-release-artifact-root")
      .map((pkg) => pkg.SPDXID)
  );
  normalizedSpdx.packages = normalizedSpdx.packages.filter((pkg) => !wrapperIds.has(pkg.SPDXID));
  normalizedSpdx.relationships = normalizedSpdx.relationships
    .filter(
      (relation) =>
        !wrapperIds.has(relation.spdxElementId) &&
        !wrapperIds.has(relation.relatedSpdxElement) &&
        relation.relationshipType !== "DESCRIBES"
    )
    .map((relation) => {
      if (
        relation.relationshipType === "DEPENDENCY_OF" ||
        relation.relationshipType === "PREREQUISITE_FOR" ||
        relation.relationshipType === "OPTIONAL_DEPENDENCY_OF"
      ) {
        return {
          spdxElementId: relation.relatedSpdxElement,
          relatedSpdxElement: relation.spdxElementId,
          relationshipType: "DEPENDS_ON"
        };
      }
      return relation;
    });
  normalizedSpdx.relationships.push({
    spdxElementId: "SPDXRef-DOCUMENT",
    relatedSpdxElement: root.SPDXID,
    relationshipType: "DESCRIBES"
  });
  normalizedSpdx.name = releaseTag;
  normalizedSpdx.documentNamespace = `${repository}/sbom/${encodeURIComponent(releaseTag)}/${sourceSha}`;
  normalizedSpdx.documentDescribes = [root.SPDXID];
  normalizedSpdx.creationInfo = {
    created: generatedAt,
    creators: [...new Set([...(spdx.creationInfo?.creators ?? []), "Organization: Velum Labs"])].sort(compareText),
    comment: `Generated for ${releaseTag} from ${repository}/commit/${sourceSha}`
  };
  normalizedSpdx.packages.sort((a, b) =>
    compareText(`${a.name}\0${a.versionInfo ?? ""}\0${a.SPDXID}`, `${b.name}\0${b.versionInfo ?? ""}\0${b.SPDXID}`)
  );
  normalizedSpdx.relationships.sort((a, b) =>
    compareText(
      `${a.spdxElementId}\0${a.relationshipType}\0${a.relatedSpdxElement}`,
      `${b.spdxElementId}\0${b.relationshipType}\0${b.relatedSpdxElement}`
    )
  );

  // pnpm's SPDX package suffixes depend on traversal order. Rewrite them from
  // package identity so repeated generation is byte-for-byte reproducible.
  const idReplacements = new Map();
  for (const pkg of normalizedSpdx.packages) {
    if (pkg.SPDXID === root.SPDXID) continue;
    const purl = purlOf(pkg) ?? `${pkg.name}@${pkg.versionInfo ?? "NOASSERTION"}`;
    const stableId = `SPDXRef-Package-${Buffer.from(purl, "utf8").toString("base64url")}`;
    assert(![...idReplacements.values()].includes(stableId), `duplicate stable SPDX id for ${packageKey(pkg)}`);
    idReplacements.set(pkg.SPDXID, stableId);
    pkg.SPDXID = stableId;
  }
  for (const relation of normalizedSpdx.relationships) {
    relation.spdxElementId = idReplacements.get(relation.spdxElementId) ?? relation.spdxElementId;
    relation.relatedSpdxElement =
      idReplacements.get(relation.relatedSpdxElement) ?? relation.relatedSpdxElement;
  }

  const depths = dependencyDepths(root.SPDXID, normalizedSpdx.relationships);
  const deduped = new Map();
  for (const pkg of normalizedSpdx.packages) {
    const depth = depths.get(pkg.SPDXID);
    if (depth === undefined || depth === 0 || pkg.name.startsWith(FIRST_PARTY_PREFIX)) continue;
    const license = pkg.licenseDeclared ?? "NOASSERTION";
    const policy = licensePolicy(pkg.name, pkg.versionInfo ?? "NOASSERTION", license);
    const entry = {
      name: pkg.name,
      version: pkg.versionInfo ?? "NOASSERTION",
      license,
      scope: depth === 1 ? "direct" : "transitive",
      dependencyDepth: depth,
      ...(purlOf(pkg) ? { purl: purlOf(pkg) } : {}),
      ...(packageSource(pkg) ? { source: packageSource(pkg) } : {}),
      ...(checksumOf(pkg) ? { sha512: checksumOf(pkg) } : {}),
      policy
    };
    const key = packageKey(pkg);
    const existing = deduped.get(key);
    if (existing === undefined || entry.dependencyDepth < existing.dependencyDepth) deduped.set(key, entry);
  }
  const packages = [...deduped.values()].sort((a, b) =>
    compareText(`${a.name}\0${a.version}`, `${b.name}\0${b.version}`)
  );
  const rejected = packages.filter((pkg) => pkg.policy.status === "rejected");
  assert(
    rejected.length === 0,
    `license policy rejected ${rejected.map((pkg) => `${pkg.name}@${pkg.version}: ${pkg.policy.reason}`).join("; ")}`
  );
  const byLicense = Object.fromEntries(
    [...new Set(packages.map((pkg) => pkg.license))]
      .sort(compareText)
      .map((license) => [license, packages.filter((pkg) => pkg.license === license).length])
  );
  const inventory = {
    schemaVersion: 1,
    package: { name: ROOT_PACKAGE, version: expectedVersion },
    releaseTag,
    source: { repository, sha: sourceSha },
    generatedAt,
    policy: {
      allowedSpdxLicenses: [...ALLOWED_LICENSES].sort(compareText),
      reviewedExceptionPackages: [
        "@anthropic-ai/claude-agent-sdk and platform packages",
        "@openai/codex platform packages"
      ],
      status: "pass"
    },
    summary: {
      thirdPartyPackages: packages.length,
      direct: packages.filter((pkg) => pkg.scope === "direct").length,
      transitive: packages.filter((pkg) => pkg.scope === "transitive").length,
      reviewedExceptions: packages.filter((pkg) => pkg.policy.status === "reviewed-exception").length,
      byLicense
    },
    packages
  };
  return { spdx: normalizedSpdx, inventory };
}

export const RELEASE_ROOT_PACKAGE = ROOT_PACKAGE;
