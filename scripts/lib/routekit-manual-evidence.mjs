import assert from "node:assert/strict";

import {
  assertSanitized,
  mappingDigest,
  validateEvidence,
  validateMatrixReport
} from "./routekit-l06-evidence.mjs";
import { routeById } from "../routekit-qualification.mjs";

const REVIEWED_ROUTE_IDS = Object.freeze([
  "route-codex-subscription",
  "route-claude-code-subscription"
]);
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+() _/-]{0,159}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

function exactKeys(value, keys, label) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has untrusted fields`);
}

function exactVersion(value, label) {
  assert.ok(
    typeof value === "string" &&
      SAFE_VERSION.test(value) &&
      !/\b(?:unavailable|pending|unknown|tbd|awaiting)\b/i.test(value),
    `${label} is unavailable`
  );
  return value;
}

function namespacedModel(value, label) {
  assert.ok(
    typeof value === "string" &&
      SAFE_MODEL.test(value) &&
      value.includes("/") &&
      !/(?:sk-|bearer|secret|token|credential)/i.test(value),
    `${label} must be an exact namespaced model`
  );
  return value;
}

function passCase(byCaseId, caseId) {
  const result = byCaseId.get(caseId);
  assert.ok(result !== undefined, `required matrix case ${caseId} is missing`);
  assert.equal(result.status, "pass", `required matrix case ${caseId} did not pass`);
  return result;
}

function matrixFoundation(mapping, report, revision) {
  const byCaseId = validateMatrixReport(mapping, report, revision, {
    supportedSchemas: [4]
  });
  assert.equal(report.evidenceMappingSchemaVersion, mapping.schemaVersion);
  assert.equal(report.liveAuthorized, true, "reviewed evidence requires an authorized live matrix");
  assert.equal(report.metadata?.routekitGitSha, revision, "matrix metadata names a stale revision");
  assert.equal(report.metadata?.gitDirty, false, "matrix metadata reports dirty sources");
  assert.equal(report.metadata?.routekitVersion, report.routekitVersion);
  exactVersion(report.routekitVersion, "RouteKit version");
  assert.match(report.finishedAt, /^20\d{2}-\d{2}-\d{2}T/, "matrix finishedAt is invalid");
  assert.ok(report.qualification !== null && typeof report.qualification === "object");
  assert.ok(Array.isArray(report.qualification.routes), "matrix qualification routes are missing");
  assert.ok(
    Number.isInteger(report.liveGatewayRequestsObserved) &&
      report.liveGatewayRequestsObserved > 0,
    "matrix observed zero live gateway requests"
  );
  const budget = report.qualification.budget;
  assert.ok(budget !== null && typeof budget === "object", "matrix qualification budget is missing");
  assert.ok(
    Number.isInteger(budget.authorizedMaximum) &&
      Number.isInteger(budget.plannedMaximum) &&
      Number.isInteger(budget.gatewayRequestsObserved),
    "matrix qualification budget is invalid"
  );
  assert.equal(
    budget.gatewayRequestsObserved,
    report.liveGatewayRequestsObserved,
    "matrix gateway observations are inconsistent"
  );
  assert.ok(
    budget.plannedMaximum <= budget.authorizedMaximum &&
      budget.gatewayRequestsObserved <= budget.authorizedMaximum,
    "matrix gateway observations exceed the authorized budget"
  );
  return byCaseId;
}

function qualificationRoute(report, routeId) {
  const matches = report.qualification.routes.filter((route) => route.routeId === routeId);
  assert.equal(matches.length, 1, `matrix must contain exactly one ${routeId} qualification`);
  return matches[0];
}

function assertSupportingCases(byCaseId, route) {
  const protocolDoor = route.door === "cursor-ide" ? "openai-chat" : route.door;
  const cases = {
    cancellation: "deterministic.shared.cancellation",
    failurePropagation:
      `deterministic.${route.provider}.failure-no-fallback-${protocolDoor}`,
    protocol: `deterministic.${route.provider}.tools-reasoning-${protocolDoor}`
  };
  const observed = Object.fromEntries(
    Object.entries(cases).map(([name, caseId]) => [
      name,
      passCase(byCaseId, caseId)
    ])
  );
  return {
    cases,
    behavior: {
      cancellation: observed.cancellation.status,
      failurePropagation: observed.failurePropagation.status,
      routekitFallback:
        observed.failurePropagation.status === "pass" ? "none" : "unverified"
    }
  };
}

function assertMappedCases(mappingRoute, route, byCaseId) {
  for (const caseId of mappingRoute.requiredCaseIds) {
    const result = passCase(byCaseId, caseId);
    if (
      result.phase === "live" &&
      result.door !== "pool"
    ) {
      assert.ok(
        Number.isInteger(result.gatewayRequests) &&
          result.gatewayRequests > 0 &&
          result.gatewayRequests <= route.maxGatewayRequests,
        `${caseId} has a zero or over-budget gateway observation`
      );
    }
  }
}

function assertReviewedQualification(mapping, report, byCaseId, routeId) {
  const route = routeById(routeId);
  const mappingRoute = mapping.routes.find((candidate) => candidate.id === routeId);
  assert.ok(route !== undefined && mappingRoute !== undefined);
  const result = qualificationRoute(report, routeId);
  assert.equal(result.status, "fail", `${routeId} must retain manual-evidence gating`);
  assert.equal(result.reasonCode, "manual-evidence-unavailable");
  assert.equal(result.provider?.id, route.provider);
  assert.equal(result.provider?.egressHost, route.egressHost);
  assert.equal(result.provider?.aggregator, route.aggregator);
  const model = namespacedModel(result.provider?.model, `${routeId} model`);
  assert.ok(
    model.startsWith(`${route.provider}/`),
    `${routeId} model uses the wrong namespace`
  );
  assert.equal(result.credential?.mode, route.credentialMode);
  assert.equal(result.credential?.reference, route.credentialReference);
  assert.equal(result.credential?.available, true, `${routeId} credential is unavailable`);
  assert.equal(result.client?.id, route.client);
  const clientVersion = exactVersion(result.client?.version, `${routeId} client version`);
  const metadataClient = {
    "route-codex-subscription": report.metadata?.clients?.codex,
    "route-claude-code-subscription": report.metadata?.clients?.claude
  }[routeId];
  assert.equal(clientVersion, metadataClient, `${routeId} client version disagrees with metadata`);
  assert.equal(result.protocol?.door, route.door);
  assert.equal(result.protocol?.path, route.protocolPath);
  assert.equal(result.protocol?.streaming, "pass", `${routeId} streaming failed`);
  assert.equal(result.protocol?.tools, "pass", `${routeId} tools failed`);
  assert.equal(result.protocol?.reasoning, "pass", `${routeId} reasoning failed`);
  assert.equal(result.behavior?.cancellation, "pass", `${routeId} cancellation failed`);
  assert.equal(result.behavior?.failurePropagation, "pass", `${routeId} failure propagation failed`);
  assert.equal(result.behavior?.routekitFallback, "none", `${routeId} RouteKit fallback was observed`);
  assert.equal(result.billing?.mode, route.billingMode);
  assert.equal(result.billing?.attributionBasis, "namespaced-route-success");
  assert.ok(
    Number.isInteger(result.billing?.gatewayRequestsObserved) &&
      result.billing.gatewayRequestsObserved > 0 &&
      result.billing.gatewayRequestsObserved <= route.maxGatewayRequests,
    `${routeId} has a zero or over-budget gateway observation`
  );
  assert.equal(result.setupRestore?.expectation, "required");
  assert.equal(result.setupRestore?.setup, "pass", `${routeId} setup failed`);
  assert.equal(result.setupRestore?.restore, "pass", `${routeId} restore failed`);
  assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0);
  assertSupportingCases(byCaseId, route);
  assertMappedCases(mappingRoute, route, byCaseId);
  return { route, result, model, clientVersion };
}

function reviewedRecord({ route, result, model, clientVersion, report, reportDigest }) {
  const reasoning = result.protocol.reasoning;
  const requests = result.billing.gatewayRequestsObserved;
  return {
    credentialMode: {
      "route-codex-subscription":
        "Enrolled Codex subscription account staged into isolated RouteKit state.",
      "route-claude-code-subscription":
        "Enrolled Claude Code subscription account staged into isolated RouteKit state."
    }[route.routeId],
    clientProviderVersion:
      `${clientVersion}; RouteKit ${report.routekitVersion}; model ${model}.`,
    qualificationStatus: "qualified",
    evidence: [
      {
        status: "pass",
        label: `${route.routeId} trusted machine review`,
        reference: `reviewed-matrix:${reportDigest.slice(0, 20)}:${route.routeId}`,
        summary:
          "Derived from revision-bound allowlisted matrix and harness observations; no raw transcript was retained."
      }
    ],
    outcomes: {
      protocolBehavior: {
        status: "pass",
        summary:
          `${result.protocol.door} streaming and tools passed; reasoning ${reasoning}.`
      },
      billingAttribution: {
        status: "pass",
        summary:
          `${requests} bounded gateway request${requests === 1 ? "" : "s"} reached namespaced model ${model}.`
      },
      failureBehavior: {
        status: "pass",
        summary:
          "Cancellation and selected-route failure propagation passed with no RouteKit fallback."
      },
      setupRestore: {
        status: "pass",
        summary: "Isolated setup passed and the allowlisted source state was unchanged after cleanup."
      }
    }
  };
}

export function deriveReviewedManualRecords(mapping, report, options = {}) {
  const revision = options.revision ?? report.sourceRevision;
  const byCaseId = matrixFoundation(mapping, report, revision);
  const reportDigest = mappingDigest(report);
  const routes = {};
  for (const routeId of REVIEWED_ROUTE_IDS) {
    routes[routeId] = reviewedRecord({
      ...assertReviewedQualification(mapping, report, byCaseId, routeId),
      report,
      reportDigest
    });
  }
  const records = {
    schemaVersion: 3,
    kind: "routekit-reviewed-manual-records",
    producer: "scripts/generate-routekit-manual-records.mjs",
    testedRevision: revision,
    evidenceDate: report.finishedAt.slice(0, 10),
    evidenceMappingSchemaVersion: mapping.schemaVersion,
    evidenceMappingDigest: mappingDigest(mapping),
    matrixReportDigest: reportDigest,
    routes
  };
  assertSanitized(records);
  return records;
}

export function validateReviewedManualRecords(mapping, report, records) {
  exactKeys(
    records,
    [
      "schemaVersion",
      "kind",
      "producer",
      "testedRevision",
      "evidenceDate",
      "evidenceMappingSchemaVersion",
      "evidenceMappingDigest",
      "matrixReportDigest",
      "routes"
    ],
    "reviewed manual records"
  );
  const expected = deriveReviewedManualRecords(mapping, report, {
    revision: records.testedRevision
  });
  assert.deepEqual(records, expected, "manual records are not the trusted matrix projection");
}

export function applyReviewedManualRecords(mapping, source, report, records) {
  validateReviewedManualRecords(mapping, report, records);
  assert.equal(
    records.testedRevision,
    source.testedRevision,
    "manual records were reviewed against a different revision"
  );
  const next = structuredClone(source);
  next.evidenceDate = records.evidenceDate;
  for (const [routeId, record] of Object.entries(records.routes)) {
    const row = next.routes[routeId];
    row.credentialMode = record.credentialMode;
    row.clientProviderVersion = record.clientProviderVersion;
    row.qualificationStatus = record.qualificationStatus;
    row.outcomes = { ...row.outcomes, ...record.outcomes };
    row.evidence = [
      ...row.evidence.filter((item) => item.type !== "manual"),
      ...record.evidence.map((item) => ({ ...item, type: "manual" }))
    ];
  }
  validateEvidence(mapping, next);
  return next;
}
