import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { LAUNCH_ROUTE_IDS } from "../launch-support.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const routekitCli = join(root, "packages", "cli", "dist", "index.js");
const cliEnv = { ...process.env, ROUTEKIT_NO_TUI: "1" };
const routeDisclosuresPath = "docs/routekit-routes-and-billing.md";
const hasAppsDocs = existsSync(join(root, "apps/docs"));

function help(args: readonly string[]): string {
  return execFileSync(process.execPath, [routekitCli, ...args], {
    encoding: "utf8",
    env: cliEnv
  });
}

test("documented safe CLI commands remain executable", () => {
  for (const [cli, args] of [
    [routekitCli, ["start", "--help"]],
    [routekitCli, ["status", "--help"]],
    [routekitCli, ["stop", "--help"]],
    [routekitCli, ["accounts", "add", "--help"]],
    [routekitCli, ["providers", "add", "--help"]],
    [routekitCli, ["remote", "add", "--help"]],
    [routekitCli, ["remote", "install", "--help"]],
    [routekitCli, ["remote", "use", "--help"]],
    [routekitCli, ["accounts", "login", "--help"]],
    [routekitCli, ["accounts", "remove", "--help"]],
    [routekitCli, ["accounts", "rename", "--help"]]
  ] as const) {
    const output = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: cliEnv
    });
    assert.match(output, /Usage:/);
  }
  // The cliproxy subtree is gone from the public accounts surface.
  const accountsHelp = help(["accounts", "--help"]);
  assert.match(accountsHelp, /\blogin\b/);
  assert.doesNotMatch(accountsHelp, /\bcliproxy\b/);

  const rootHelp = execFileSync(process.execPath, [routekitCli, "--help"], {
    encoding: "utf8",
    env: { ...process.env, ROUTEKIT_NO_TUI: "1" }
  });
  assert.match(rootHelp, /^\s+start\b/m);
  assert.match(rootHelp, /^\s+status\b/m);
  assert.match(rootHelp, /^\s+stop\b/m);
  assert.doesNotMatch(rootHelp, /^\s+daemon\b/m);
  assert.doesNotMatch(rootHelp, /^\s+gateway\b/m);
});

test("remote gateway commands and target overrides are documented", { skip: !hasAppsDocs }, () => {
  const source = readFileSync(
    join(root, "apps/docs/content/docs/reference/commands.mdx"),
    "utf8"
  );
  const guide = readFileSync(
    join(root, "apps/docs/content/docs/guides/remote-gateway.mdx"),
    "utf8"
  );
  for (const snippet of [
    "routekit remote add",
    "routekit remote install",
    "routekit remote list",
    "routekit remote show",
    "routekit remote use",
    "routekit remote remove",
    "--remote <name>",
    "--local"
  ]) {
    assert.ok(source.includes(snippet) || guide.includes(snippet), `missing remote docs: ${snippet}`);
  }
});

test("the public command reference covers the complete top-level CLI", { skip: !hasAppsDocs }, () => {
  const source = readFileSync(
    join(root, "apps/docs/content/docs/reference/commands.mdx"),
    "utf8"
  );
  for (const command of [
    "remote",
    "peer",
    "token",
    "accounts",
    "providers",
    "config",
    "start",
    "stop",
    "codex",
    "claude",
    "cursor",
    "status",
    "usage",
    "leaderboard",
    "calls",
    "models",
    "doctor",
    "self-update",
    "telemetry",
    "completion",
    "version"
  ]) {
    assert.match(source, new RegExp(`routekit ${command.replace("-", "\\-")}\\b`));
  }
  assert.match(source, /routekit remote install <ssh-host>/);
  assert.doesNotMatch(source, /routekit remote install <name>/);
  assert.match(source, /routekit models list/);
  assert.doesNotMatch(source, /routekit models \[list\]/);
});

test("public coding-tool docs distinguish launchers from Cursor BYOK setup", { skip: !hasAppsDocs }, () => {
  const sources = [
    "apps/docs/content/docs/index.mdx",
    "apps/docs/content/docs/guides/user-guide.mdx",
    "apps/docs/content/docs/reference/commands.mdx",
    "apps/docs/src/app/(home)/page.tsx"
  ].map((path) => readFileSync(join(root, path), "utf8"));
  const combined = sources.join("\n");
  assert.doesNotMatch(combined, /launch(?:es|ing)? Codex, Claude Code, or Cursor/i);
  assert.match(combined, /Cursor[^\n]{0,120}(?:custom endpoint|Override OpenAI Base URL)/i);
  assert.match(combined, /does not launch[\s\S]{0,80}(?:editor|cursor-agent)/i);
});

test("public onboarding establishes a routable daemon before subscription enrollment", { skip: !hasAppsDocs }, () => {
  const installation = readFileSync(
    join(root, "apps/docs/content/docs/getting-started/installation.mdx"),
    "utf8"
  );
  assert.ok(
    installation.indexOf("export OPENAI_API_KEY") < installation.indexOf("routekit config init")
  );
  assert.match(installation, /Expected result:[\s\S]{0,240}127\.0\.0\.1:8080/);

  for (const path of [
    "apps/docs/content/docs/guides/subscription-pooling.mdx",
    "docs/subscription-pooling.md"
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.ok(source.indexOf("routekit start") < source.indexOf("accounts login claude-code"));
    assert.match(source, /Enrollment is daemon-backed/);
    assert.match(source, /cannot bootstrap its first subscription account/i);
  }
});

test("native client install lifecycle and credentialless mode are public", { skip: !hasAppsDocs }, () => {
  const sources = [
    "apps/docs/content/docs/guides/user-guide.mdx",
    "apps/docs/content/docs/reference/commands.mdx",
    "apps/docs/content/docs/concepts/privacy.mdx"
  ].map((path) => readFileSync(join(root, path), "utf8").toLowerCase());
  const combined = sources.join("\n");
  for (const snippet of [
    "routekit codex install",
    "routekit claude install",
    "--rotate-token",
    "--no-token",
    "routekit_gateway_token",
    "anthropic_auth_token",
    "native-clients.json"
  ]) {
    assert.ok(combined.includes(snippet), `public native integration docs are missing ${snippet}`);
  }
  assert.match(combined, /--no-token[\s\S]{0,600}(?:cannot|can't) be combined with `--rotate-token`/);
});

test("public changelog includes the current CLI release", { skip: !hasAppsDocs }, () => {
  const packageJson = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")) as {
    version: string;
  };
  const changelog = readFileSync(join(root, "apps/docs/content/docs/changelog.mdx"), "utf8");
  assert.match(changelog, /^generated: true$/m);
  assert.match(changelog, new RegExp(`^## ${packageJson.version.replaceAll(".", "\\.")}\\b`, "m"));
  execFileSync(
    process.execPath,
    [join(root, "scripts/docs/generate-public-changelog.mjs"), "--check"],
    {
      encoding: "utf8"
    }
  );
});

test("public setup separates API-key and subscription journeys", { skip: !hasAppsDocs }, () => {
  const installation = readFileSync(
    join(root, "apps/docs/content/docs/getting-started/installation.mdx"),
    "utf8"
  );
  const pooling = readFileSync(
    join(root, "apps/docs/content/docs/guides/subscription-pooling.mdx"),
    "utf8"
  );
  assert.match(installation, /<Tabs items=\{\["API key", "Subscription account"\]\}>/);
  assert.match(installation, /routekit providers remove openai/);
  assert.match(pooling, /<Tabs items=\{\["Claude Code", "Codex"\]\}>/);
  assert.match(pooling, /accounts login claude-code/);
  assert.match(pooling, /accounts login codex/);
});

test("public examples use Markdown fences and internal package links", {
  skip: !hasAppsDocs
}, () => {
  const userGuide = readFileSync(
    join(root, "apps/docs/content/docs/guides/user-guide.mdx"),
    "utf8"
  );
  const configuration = readFileSync(
    join(root, "apps/docs/content/docs/reference/configuration.mdx"),
    "utf8"
  );
  assert.doesNotMatch(`${userGuide}\n${configuration}`, /RouteKitModelsCode/);
  assert.match(userGuide, /```sh\nroutekit cursor openrouter\//);
  assert.match(configuration, /```yaml\nproviders:/);

  const api = readFileSync(join(root, "apps/docs/content/docs/reference/api.mdx"), "utf8");
  const packages = readFileSync(
    join(root, "apps/docs/content/docs/reference/packages.mdx"),
    "utf8"
  );
  assert.match(api, /not tested or supported as a public embedded API/i);
  assert.doesNotMatch(
    `${api}\n${packages}`,
    /github\.com\/velum-labs\/routekit\/blob\/main\/docs\/typescript-reference/
  );
  assert.match(packages, /\[TypeScript package status\]\(\/docs\/reference\/api\)/);
});

test("the maintainer remote guide documents provisioning and its limits", () => {
  const guide = readFileSync(join(root, "docs/routekit-remote-gateways.md"), "utf8");
  for (const snippet of ["routekit remote install", "--dry-run", "--version"]) {
    assert.ok(guide.includes(snippet), `missing remote install docs: ${snippet}`);
  }
  // Provisioning deliberately stops short of privilege escalation, Node
  // installation, and network exposure; the guide must keep saying so.
  assert.match(guide, /no sudo/i);
  assert.match(guide, /private Node/);
  assert.match(guide, /binds loopback/i);
  // The PATH preamble is why a user-owned npm prefix works at all.
  assert.match(guide, /does not run a login shell/i);
  assert.match(guide, /shell\//);
  assert.match(guide, /generate-shell-scripts/);
});

test("first-launch help exposes only supported RouteKit routes", () => {
  const rootHelp = help(["--help"]);
  for (const command of ["codex", "claude", "cursor", "accounts", "providers"]) {
    assert.match(rootHelp, new RegExp(`^  ${command}(?:[ <\\[]|$)`, "m"));
  }
  assert.doesNotMatch(rootHelp, /\bopencode\b/i);

  const loginHelp = help(["accounts", "login", "--help"]);
  assert.match(loginHelp, /claude-code, codex/);
  assert.doesNotMatch(loginHelp, /\b(?:gemini|grok|kimi|cliproxy)\b/i);
});

test("public RouteKit docs contain no not-offered onboarding commands", { skip: !hasAppsDocs }, () => {
  for (const path of [
    "README.md",
    "packages/cli/README.md",
    "docs/configuration.md",
    "docs/subscription-pooling.md",
    "apps/docs/content/docs/guides/subscription-pooling.mdx",
    "apps/docs/content/docs/getting-started/installation.mdx",
    "configs/models.example.yaml"
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.doesNotMatch(
      source,
      /\broutekit\s+(?:opencode\b|accounts\s+login\s+(?:gemini|grok|kimi)\b|providers\s+add\s+(?:google|cliproxy)\b)/i,
      `${path} advertises a route that is not offered at first launch`
    );
  }
});

test("usage reset workflow is documented across public references", { skip: !hasAppsDocs }, () => {
  for (const path of [
    "docs/subscription-pooling.md",
    "apps/docs/content/docs/guides/subscription-pooling.mdx",
    "apps/docs/content/docs/reference/commands.mdx",
    "docs/cli.md"
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    for (const snippet of ["routekit usage", "usage --watch", "usage redeem", "--credit-id"]) {
      assert.ok(source.includes(snippet), `${path} is missing ${snippet}`);
    }
    assert.match(source, /soonest-expiring/i);
    assert.match(source, /provider choose|provider-selected/i);
  }
});

test("subscription docs expose rename and keep API keys explicitly unlabeled", { skip: !hasAppsDocs }, () => {
  for (const path of [
    "docs/subscription-pooling.md",
    "apps/docs/content/docs/guides/subscription-pooling.mdx"
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.match(source, /routekit accounts rename codex work personal/);
    assert.match(source, /API[- ]key providers[\s\S]{0,300}unlabeled/i);
    assert.match(source, /does not currently (?:store |have )named API credential slots/i);
  }
});

test("retained implementation references are explicitly non-contractual", { skip: !hasAppsDocs }, () => {
  for (const path of [
    "packages/accounts/README.md",
    "apps/docs/content/docs/reference/packages.mdx",
    "docs/packages.md",
    "configs/benchmark-router.example.yaml",
    "docs/routekit-account-activation-evidence.md"
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.match(
      source,
      /non-contractual|not first-launch qualification|does not add them to RouteKit's launch support/i,
      `${path} does not label retained implementation details as non-contractual`
    );
  }

  const installation = readFileSync(
    join(root, "apps/docs/content/docs/getting-started/installation.mdx"),
    "utf8"
  );
  assert.match(installation, /accounts login claude-code/);
  assert.match(installation, /accounts login codex/);
  assert.doesNotMatch(installation, /accounts add <kind>/);

  const changelogPath = "packages/cli/CHANGELOG.md";
  if (existsSync(join(root, changelogPath))) {
    const source = readFileSync(join(root, changelogPath), "utf8");
    assert.match(
      source,
      /retained internal Google[\s\S]{0,120}outside RouteKit's public\s+support contract/i,
      `${changelogPath} does not distinguish the retained Google backend from public support`
    );
  }
  const docsChangelog = "apps/docs/content/docs/changelog.mdx";
  if (existsSync(join(root, docsChangelog))) {
    const source = readFileSync(join(root, docsChangelog), "utf8");
    assert.match(
      source,
      /retained internal Google[\s\S]{0,120}outside RouteKit's public\s+support contract/i,
      `${docsChangelog} does not distinguish the retained Google backend from public support`
    );
  }
});

test("every first-launch route has a complete public disclosure", { skip: !hasAppsDocs }, () => {
  const source = readFileSync(
    join(root, "apps/docs/content/docs/reference/routes-and-billing.mdx"),
    "utf8"
  );
  const mirror = readFileSync(join(root, "docs/routekit-routes-and-billing.md"), "utf8");
  const routeIds = [...LAUNCH_ROUTE_IDS];
  const evidenceMapping = JSON.parse(
    readFileSync(join(root, "spec/routekit/l06-evidence-map.json"), "utf8")
  ) as { routes: Array<{ id: string; requiredCaseIds: string[] }> };
  const evidenceReport = JSON.parse(
    readFileSync(join(root, "docs/routekit-l06-evidence.json"), "utf8")
  ) as {
    mappingDigest: string;
    routekitVersion: string;
    testedRevision: string;
    evidenceDate: string;
    routes: Record<
      string,
      {
        qualificationStatus: "pending" | "qualified" | "failed";
        evidence: Array<{ caseId?: string; reference: string; status: string; type: string }>;
      }
    >;
  };
  const evidenceMarkdown = readFileSync(join(root, "docs/routekit-l06-evidence.md"), "utf8");
  assert.deepEqual(
    evidenceMapping.routes.map((route) => route.id),
    routeIds,
    "L06 evidence mapping drifted from the launch route contract"
  );
  assert.deepEqual(
    Object.keys(evidenceReport.routes),
    routeIds,
    "durable L06 report must cover exactly the launch routes"
  );
  assert.match(evidenceReport.mappingDigest, /^[0-9a-f]{64}$/);
  assert.match(evidenceMarkdown, new RegExp(evidenceReport.mappingDigest));
  assert.match(evidenceReport.testedRevision, /^[0-9a-f]{40}$/);
  assert.match(source, new RegExp(evidenceReport.testedRevision));
  assert.match(source, new RegExp(evidenceReport.evidenceDate));
  assert.doesNotMatch(source, /\bL06 (?:Pass|Fail)\b/);
  const requiredFields = [
    "**Status and evidence:**",
    "**Credential:**",
    "**Billing:**",
    "**Egress and aggregator:**",
    "**Quota and failover:**",
    "**Protocol and limitations:**",
    "**Unlimited use:**"
  ];
  const requiredMirrorFields = [
    "**Credential / owner:**",
    "**Billing / egress:**",
    "**Quota / fallback:**",
    "**Protocol / limitations:**",
    "**Evidence:**"
  ];

  for (const [index, routeId] of routeIds.entries()) {
    const anchor = `<a id="${routeId}"></a>`;
    const start = source.indexOf(anchor);
    assert.notEqual(start, -1, `${routeDisclosuresPath} is missing ${routeId}`);
    const nextAnchor =
      index + 1 < routeIds.length ? `<a id="${routeIds[index + 1]}"></a>` : "## Qualification evidence";
    const end = source.indexOf(nextAnchor, start + anchor.length);
    assert.notEqual(end, -1, `${routeDisclosuresPath} cannot delimit ${routeId}`);
    const section = source.slice(start, end);

    for (const field of requiredFields) {
      assert.ok(section.includes(field), `${routeId} is missing ${field}`);
    }
    assert.match(
      section,
      new RegExp(
        `github\\.com/velum-labs/routekit/blob/main/docs/routekit-l06-evidence\\.md#${routeId}`
      ),
      `${routeId} does not link its stable durable evidence row`
    );
    assert.match(
      section,
      new RegExp(`RouteKit ${evidenceReport.routekitVersion.replaceAll(".", "\\.")}`)
    );
    assert.match(section, /\b20\d{2}-\d{2}-\d{2}\b/);
    assert.match(section, /makes no unlimited-use claim/i);

    const mirrorAnchor = `<a id="${routeId}"></a>`;
    const mirrorStart = mirror.indexOf(mirrorAnchor);
    assert.notEqual(mirrorStart, -1, `maintainer mirror is missing ${routeId}`);
    const nextMirrorAnchor =
      index + 1 < routeIds.length
        ? `<a id="${routeIds[index + 1]}"></a>`
        : "## Qualification requirement";
    const mirrorEnd = mirror.indexOf(nextMirrorAnchor, mirrorStart + mirrorAnchor.length);
    assert.notEqual(mirrorEnd, -1, `maintainer mirror cannot delimit ${routeId}`);
    const mirrorSection = mirror.slice(mirrorStart, mirrorEnd);
    for (const field of requiredMirrorFields) {
      assert.ok(mirrorSection.includes(field), `maintainer mirror ${routeId} is missing ${field}`);
    }
    assert.match(
      mirrorSection,
      new RegExp(`routekit-l06-evidence\\.md#${routeId}`),
      `maintainer mirror ${routeId} does not link its durable evidence row`
    );
    assert.match(
      mirrorSection,
      new RegExp(`RouteKit ${evidenceReport.routekitVersion.replaceAll(".", "\\.")}`)
    );
    assert.match(mirrorSection, /\b20\d{2}-\d{2}-\d{2}\b/);

    const mapped = evidenceMapping.routes[index];
    assert.equal(mapped?.id, routeId);
    const evidence = evidenceReport.routes[routeId];
    assert.ok(evidence !== undefined, `${routeId} has no durable evidence`);
    assert.match(
      section,
      new RegExp(`Current qualification: ${evidence.qualificationStatus}\\b`, "i"),
      `${routeId} public qualification status drifted from durable evidence`
    );
    const caseIds = new Set(evidence.evidence.flatMap((item) => item.caseId ?? []));
    for (const caseId of mapped.requiredCaseIds) {
      assert.ok(caseIds.has(caseId), `${routeId} lacks mapped evidence ${caseId}`);
    }
    assert.ok(
      evidence.evidence.every(
        (item) =>
          ["automated", "manual"].includes(item.type) &&
          ["pending", "pass", "fail"].includes(item.status) &&
          item.reference.length > 0
      ),
      `${routeId} contains incomplete evidence`
    );
    assert.match(evidenceMarkdown, new RegExp(`<a id="${routeId}"></a>`));
  }

  const registry = JSON.parse(
    readFileSync(join(root, "spec/registry/providers.json"), "utf8")
  ) as {
    providers: Record<string, { baseUrl?: string; keyEnv?: string }>;
  };
  for (const [routeId, providerId] of [
    ["route-openai-api", "openai"],
    ["route-anthropic-api", "anthropic"],
    ["route-openrouter-api", "openrouter"]
  ] as const) {
    const start = source.indexOf(`<a id="${routeId}"></a>`);
    const end = source.indexOf("<a id=", start + 1);
    const section = source.slice(start, end);
    const provider = registry.providers[providerId];
    assert.ok(provider?.keyEnv !== undefined);
    assert.ok(provider.baseUrl !== undefined);
    assert.match(section, new RegExp(provider.keyEnv));
    assert.match(section, new RegExp(new URL(provider.baseUrl).hostname.replaceAll(".", "\\.")));
  }
  const anthropic = source.slice(
    source.indexOf('<a id="route-anthropic-api"></a>'),
    source.indexOf('<a id="route-openrouter-api"></a>')
  );
  assert.match(anthropic, /does not\s+currently use `ANTHROPIC_AUTH_TOKEN`/);

  const openRouter = source.slice(
    source.indexOf('<a id="route-openrouter-api"></a>'),
    source.indexOf('<a id="route-codex-subscription"></a>')
  );
  assert.match(openRouter, /OpenRouter is an aggregator/i);
  assert.match(openRouter, /upstream provider/i);
  assert.match(openRouter, /prompts, code, tool data, and model requests/i);

  const evidenceRevision = source.match(
    /github\.com\/velum-labs\/routekit\/commit\/([0-9a-f]{40})/
  )?.[1];
  assert.ok(evidenceRevision !== undefined, "public disclosure lacks an immutable evidence revision");
  assert.match(mirror, new RegExp(evidenceRevision));
  assert.match(
    source,
    new RegExp(
      `github\\.com/velum-labs/routekit/blob/${evidenceRevision}/docs/routekit-e2e-matrix\\.md`
    )
  );
});

test("Bedrock docs keep AWS auth, IAM, billing, and evidence boundaries explicit", () => {
  const setup = readFileSync(join(root, "docs/aws-bedrock-setup.md"), "utf8");
  const normalizedSetup = setup.replace(/\s+/g, " ");
  for (const snippet of [
    "AWS SDK default credential provider chain",
    "bedrock:ListFoundationModels",
    "bedrock:ListInferenceProfiles",
    "bedrock:InvokeModel",
    "foundation-model/APPROVED_MODEL_ID",
    "inference-profile/APPROVED_SYSTEM_PROFILE_ID",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "routekit providers add bedrock",
    "routekit providers status bedrock",
    "Override OpenAI Base URL",
    "AWS Budgets",
    "CloudTrail"
  ]) {
    assert.ok(
      normalizedSetup.includes(snippet),
      `Bedrock setup guide is missing ${snippet}`
    );
  }
  assert.match(setup, /cross-region[\s\S]{0,180}destination model/i);
  assert.match(setup, /Do not put access keys[\s\S]{0,160}Git/i);
  assert.match(setup, /No live AWS account[\s\S]{0,180}verified/i);
  assert.match(setup, /evidence[\s\S]{0,200}authorized (?:operator|credentials)/i);
  assert.match(setup, /credits[\s\S]{0,200}(?:pending|account-specific)/i);

  for (const path of [
    "docs/configuration.md",
    "docs/model-catalog.md",
    "docs/routekit-routes-and-billing.md"
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.match(source, /aws-bedrock-setup\.md/, `${path} does not link the Bedrock runbook`);
  }

  const billing = readFileSync(
    join(root, "docs/routekit-routes-and-billing.md"),
    "utf8"
  );
  assert.match(billing, /<a id="route-bedrock-api"><\/a>/);
  assert.match(billing, /Pending authorized-operator qualification/);
  assert.match(billing, /No live AWS[\s\S]{0,180}(?:observed|verified)/i);
  assert.match(billing, /cross-region inference profiles/i);
});

test("route explanation contract is documented in public and maintainer surfaces", () => {
  const publicDoc = hasAppsDocs
    ? readFileSync(join(root, "apps/docs/content/docs/reference/routes-and-billing.mdx"), "utf8")
    : readFileSync(join(root, routeDisclosuresPath), "utf8");
  const mirror = readFileSync(
    join(root, "docs/routekit-routes-and-billing.md"),
    "utf8"
  );
  const readme = readFileSync(
    join(root, "packages/cli/README.md"),
    "utf8"
  );
  for (const source of [publicDoc, mirror, readme]) {
    assert.match(source, /routekit models info <provider\/model>/);
    assert.match(source, /native model/i);
    assert.match(source, /account class/i);
    assert.match(source, /billing mode/i);
    assert.match(source, /api-key[\s\S]{0,80}metered-api/);
    assert.match(source, /subscription[\s\S]{0,80}subscription/);
    assert.match(source, /unknown models? fail|unknown[\s\S]{0,80}rejected/i);
    assert.match(source, /credential/i);
  }
  assert.match(mirror, /routekit-route-info-evidence\.md/);
  assert.match(publicDoc, /routekit-route-info-evidence\.md/);
});

test("public onboarding links to the route disclosure contract", { skip: !hasAppsDocs }, () => {
  const packageReadme = readFileSync(join(root, "packages/cli/README.md"), "utf8");
  assert.match(packageReadme, /routes-and-billing|routekit-routes-and-billing/);

  for (const path of [
    "apps/docs/content/docs/getting-started/installation.mdx",
    "apps/docs/content/docs/concepts/privacy.mdx"
  ]) {
    const full = join(root, path);
    if (!existsSync(full)) continue;
    const source = readFileSync(full, "utf8");
    assert.match(source, /\]\(\/docs\/reference\/routes-and-billing(?:#[^)]+)?\)/);
  }
});
