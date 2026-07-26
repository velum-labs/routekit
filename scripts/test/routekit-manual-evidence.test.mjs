import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadEvidenceMap,
  mappingDigest,
  promoteMatrixResults,
  routeIdsForCase
} from "../lib/routekit-l06-evidence.mjs";
import {
  applyReviewedManualRecords,
  deriveReviewedManualRecords,
  validateReviewedManualRecords
} from "../lib/routekit-manual-evidence.mjs";
import { routeById } from "../routekit-qualification.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const mapping = loadEvidenceMap(ROOT);
const source = JSON.parse(
  readFileSync(join(ROOT, "spec", "routekit", "l06-evidence.json"), "utf8")
);
const REVISION = "1".repeat(40);

function result(caseId, overrides = {}) {
  const [phase, providerPart, door] = caseId.split(".");
  const provider = providerPart === "shared" ? null : providerPart;
  const identity = { phase, provider, door };
  return {
    caseId,
    routeIds: routeIdsForCase(mapping, identity),
    ...identity,
    routeId: null,
    status: "pass",
    reasonCode: "qualified",
    durationMs: 10,
    gatewayRequests: phase === "live" && door !== "pool" ? 1 : 0,
    artifact: null,
    model: phase === "live" ? `${provider}/test-model` : null,
    setupRestore: null,
    ...overrides
  };
}

function qualification(routeId, overrides = {}) {
  const route = routeById(routeId);
  const clientVersions = {
    "route-codex-subscription": "codex 1.2.3",
    "route-claude-code-subscription": "claude 4.5.6",
    "route-cursor-ide": "Cursor 9.9.9"
  };
  const model = {
    "route-codex-subscription": "codex/gpt-test",
    "route-claude-code-subscription": "claude-code/claude-test",
    "route-cursor-ide": "openai/gpt-test",
    "route-openai-api": "openai/gpt-test"
  }[routeId];
  const manual = route.manualEvidenceRequired === true;
  return {
    routeId,
    status: manual ? "fail" : "pass",
    reasonCode: manual ? "manual-evidence-unavailable" : "qualified",
    durationMs: 20,
    provider: {
      id: route.provider,
      model,
      apiRevision: "not-advertised",
      egressHost: route.egressHost,
      aggregator: route.aggregator
    },
    credential: {
      mode: route.credentialMode,
      reference: route.credentialReference,
      available: true
    },
    client: {
      id: route.client,
      version: clientVersions[routeId] ?? "0.8.0",
      integrationMode: route.door
    },
    protocol: {
      door: route.door,
      path: route.protocolPath,
      streaming: "pass",
      tools: "pass",
      reasoning: routeId === "route-cursor-ide" ? "degraded" : "pass"
    },
    behavior: {
      cancellation: "pass",
      failurePropagation: "pass",
      routekitFallback: "none",
      providerManagedRouting:
        route.aggregator ? "openrouter-upstream-routing" : "not-applicable"
    },
    billing: {
      mode: route.billingMode,
      attributionBasis: "namespaced-route-success",
      gatewayRequestsObserved: 1
    },
    setupRestore: {
      expectation: route.setupRestore,
      setup: route.setupRestore === "required" ? "pass" : "not-applicable",
      restore: route.setupRestore === "required" ? "pass" : "not-applicable"
    },
    evidence: ["trusted-matrix-case"],
    ...overrides
  };
}

function matrixReport() {
  const caseIds = [
    "deterministic.shared.cancellation",
    "deterministic.openai.openai-chat",
    "deterministic.openai.failure-no-fallback-openai-chat",
    "deterministic.openai.tools-reasoning-openai-chat",
    "live.openai.openai-chat",
    "deterministic.codex.codex-responses",
    "deterministic.codex.codex",
    "deterministic.codex.failure-no-fallback-codex-responses",
    "deterministic.codex.tools-reasoning-codex-responses",
    "live.codex.codex-responses",
    "live.codex.codex",
    "deterministic.claude-code.anthropic-messages",
    "deterministic.claude-code.anthropic-thinking",
    "deterministic.claude-code.claude",
    "deterministic.claude-code.failure-no-fallback-anthropic-messages",
    "deterministic.claude-code.tools-reasoning-anthropic-messages",
    "live.claude-code.anthropic-messages",
    "live.claude-code.claude",
    "live.claude-code.pool"
  ];
  const results = caseIds.map((caseId) => result(caseId));
  for (const entry of results.filter(
    (candidate) =>
      candidate.phase === "live" &&
      ["codex", "claude-code"].includes(candidate.provider)
  )) {
    entry.setupRestore = { setup: "pass", restore: "pass" };
  }
  const caseCounts = {
    pass: results.length,
    fail: 0,
    skip: 0
  };
  const routeIds = [
    "route-openai-api",
    "route-codex-subscription",
    "route-claude-code-subscription",
    "route-cursor-ide"
  ];
  return {
    schemaVersion: 4,
    routekitVersion: "0.8.0",
    evidenceMappingSchemaVersion: mapping.schemaVersion,
    evidenceMappingDigest: mappingDigest(mapping),
    sourceRevision: REVISION,
    sourceDirty: false,
    startedAt: "2026-07-23T07:00:00.000Z",
    finishedAt: "2026-07-23T07:10:00.000Z",
    metadata: {
      routekitVersion: "0.8.0",
      routekitGitSha: REVISION,
      gitDirty: false,
      nodeVersion: "v22.22.2",
      platform: "darwin",
      architecture: "arm64",
      clients: {
        claude: "claude 4.5.6",
        codex: "codex 1.2.3",
        cursorIde: "Cursor 9.9.9"
      }
    },
    liveAuthorized: true,
    filters: {
      routes: routeIds,
      providers: ["openai", "codex", "claude-code"],
      doors: ["openai-chat", "codex-responses", "codex", "anthropic-messages", "claude", "pool"],
      timeoutMs: 120000,
      maxLiveCalls: 8
    },
    summary: {
      status: "fail",
      caseCounts,
      topLevelFailures: 0,
      routeCounts: { pass: 1, fail: 3 }
    },
    liveGatewayRequestsObserved: 5,
    results,
    qualification: {
      status: "fail",
      completeness: {
        complete: true,
        allPassed: false,
        expectedRouteIds: routeIds,
        missingRouteIds: [],
        duplicateRouteIds: [],
        failedRouteIds: routeIds.slice(1)
      },
      budget: {
        authorizedMaximum: 8,
        plannedMaximum: 6,
        gatewayRequestsObserved: 5,
        remaining: 3,
        exhausted: false
      },
      routes: routeIds.map((routeId) => qualification(routeId))
    },
    topLevelError: null
  };
}

test("reviewed records are a fixed projection of passing machine artifacts", () => {
  const report = matrixReport();
  const records = deriveReviewedManualRecords(mapping, report, { revision: REVISION });
  assert.deepEqual(Object.keys(records.routes), [
    "route-codex-subscription",
    "route-claude-code-subscription"
  ]);
  assert.ok(
    Object.values(records.routes).every(
      (route) =>
        route.qualificationStatus === "qualified" &&
        route.evidence.every((evidence) => evidence.status === "pass")
    )
  );
  validateReviewedManualRecords(mapping, report, records);
  const promoted = promoteMatrixResults(mapping, source, report, REVISION);
  const applied = applyReviewedManualRecords(
    mapping,
    promoted,
    report,
    records
  );
  assert.equal(
    applied.routes["route-codex-subscription"].qualificationStatus,
    "qualified"
  );
});

test("the Cursor custom-endpoint route cannot be machine-reviewed", () => {
  const report = matrixReport();
  const records = deriveReviewedManualRecords(mapping, report, { revision: REVISION });
  assert.equal(records.routes["route-cursor-ide"], undefined);
  const promoted = promoteMatrixResults(mapping, source, report, REVISION);
  const applied = applyReviewedManualRecords(mapping, promoted, report, records);
  assert.notEqual(
    applied.routes["route-cursor-ide"].qualificationStatus,
    "qualified"
  );
});

test("stale, dirty, and forged mappings fail closed", () => {
  assert.throws(
    () => deriveReviewedManualRecords(mapping, matrixReport(), { revision: "2".repeat(40) }),
    /must equal the matrix source revision/
  );
  const dirty = matrixReport();
  dirty.sourceDirty = true;
  assert.throws(
    () => deriveReviewedManualRecords(mapping, dirty, { revision: REVISION }),
    /dirty-worktree/
  );
  const forged = matrixReport();
  forged.evidenceMappingDigest = "f".repeat(64);
  assert.throws(
    () => deriveReviewedManualRecords(mapping, forged, { revision: REVISION }),
    /stale L05 mapping/
  );
});

test("missing and failed required cases cannot generate records", () => {
  const missing = matrixReport();
  missing.results = missing.results.filter(
    (entry) => entry.caseId !== "live.codex.codex"
  );
  missing.summary.caseCounts.pass -= 1;
  assert.throws(
    () => deriveReviewedManualRecords(mapping, missing, { revision: REVISION }),
    /required matrix case live\.codex\.codex is missing/
  );

  const failed = matrixReport();
  failed.results.find(
    (entry) => entry.caseId === "deterministic.claude-code.anthropic-thinking"
  ).status = "fail";
  failed.summary.caseCounts.pass -= 1;
  failed.summary.caseCounts.fail += 1;
  assert.throws(
    () => deriveReviewedManualRecords(mapping, failed, { revision: REVISION }),
    /did not pass/
  );
});

test("credentials and unavailable versions are rejected", () => {
  const credential = matrixReport();
  credential.metadata.injected = { token: "sk-secret-value" };
  assert.throws(
    () => deriveReviewedManualRecords(mapping, credential, { revision: REVISION }),
    /secret field|credential-shaped/
  );

  const unavailable = matrixReport();
  unavailable.metadata.clients.codex = "unavailable";
  unavailable.qualification.routes.find(
    (route) => route.routeId === "route-codex-subscription"
  ).client.version = "unavailable";
  assert.throws(
    () => deriveReviewedManualRecords(mapping, unavailable, { revision: REVISION }),
    /client version is unavailable/
  );
});

test("zero and over-budget gateway observations are rejected", () => {
  const zero = matrixReport();
  zero.qualification.routes.find(
    (route) => route.routeId === "route-codex-subscription"
  ).billing.gatewayRequestsObserved = 0;
  assert.throws(
    () => deriveReviewedManualRecords(mapping, zero, { revision: REVISION }),
    /zero or over-budget/
  );

  const over = matrixReport();
  over.liveGatewayRequestsObserved = 9;
  over.qualification.budget.gatewayRequestsObserved = 9;
  assert.throws(
    () => deriveReviewedManualRecords(mapping, over, { revision: REVISION }),
    /exceed the authorized budget/
  );
});

test("failed protocol, behavior, and setup/restore outcomes cannot generate records", () => {
  const restoreFailed = matrixReport();
  restoreFailed.qualification.routes.find(
    (route) => route.routeId === "route-codex-subscription"
  ).setupRestore.restore = "fail";
  assert.throws(
    () => deriveReviewedManualRecords(mapping, restoreFailed, { revision: REVISION }),
    /restore failed/
  );

  const protocolFailed = matrixReport();
  protocolFailed.qualification.routes.find(
    (route) => route.routeId === "route-codex-subscription"
  ).protocol.tools = "fail";
  assert.throws(
    () => deriveReviewedManualRecords(mapping, protocolFailed, { revision: REVISION }),
    /tools failed/
  );

  const behaviorFailed = matrixReport();
  behaviorFailed.qualification.routes.find(
    (route) => route.routeId === "route-claude-code-subscription"
  ).behavior.routekitFallback = "unverified";
  assert.throws(
    () => deriveReviewedManualRecords(mapping, behaviorFailed, { revision: REVISION }),
    /fallback was observed/
  );
});

test("manual-record CLI writes only the caller path and does not echo artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-manual-cli-test-"));
  try {
    const reportPath = join(root, "report.json");
    const outputPath = join(root, "records.json");
    writeFileSync(reportPath, JSON.stringify(matrixReport()));
    const generated = spawnSync(
      process.execPath,
      [
        join(ROOT, "scripts", "generate-routekit-manual-records.mjs"),
        "--matrix-report",
        reportPath,
        "--revision",
        REVISION,
        "--output",
        outputPath
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /^WROTE /);
    assert.doesNotMatch(generated.stdout, /machine result|credentialMode|\{"schemaVersion"/);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).schemaVersion, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
