# Documentation audit — 2026-08-03

## Audit contract

### Scope

This audit covers the current worktree at revision
`5f33a6178248c1d8919610fc79c700fb777b2e61`, with RouteKit CLI version `0.18.1`.
It evaluates repository source only. It does not compare the deployed site or
claim runtime journey verification.

The audited surfaces are:

- the public Fumadocs content and supporting application source;
- `README.md`, `SECURITY.md`, and `AGENTS.md`;
- maintainer documentation and historical evidence under `docs/`;
- every package README, changelog, manifest, export surface, and exported JSDoc;
- every file under `spec/`;
- CLI help, error text, and generated agent manifests;
- release, publishing, and documentation-maintenance instructions;
- generated `llms.txt`, command/error manifests, and local TypeDoc output.

The August 1 public audit was not used as a correctness baseline. It was audited
as a historical report and all current claims were evaluated from scratch.

### Audiences

1. New RouteKit users
2. Coding-agent users configuring Codex or Claude Code
3. Team and platform operators
4. AI agents and machine consumers
5. OpenAI-compatible API integrators
6. Contributors and maintainers
7. TypeScript package consumers

### Evidence precedence

1. Runtime implementation and schemas
2. Tests and generated artifacts
3. Specs explicitly describing implemented behavior
4. CLI help and error output
5. Documentation

Conflicts are still findings even when this order resolves the factual question.
Historical evidence was treated as immutable and checked for date, revision,
provenance, canonicality, status labels, and links rather than reinterpreted as
current qualification.

### Method and limitations

The audit inventoried 23 public MDX pages, 26 maintainer Markdown documents, 17
package READMEs, 23 package changelogs, 10 specification files, two generated
agent manifests, `llms.txt`, repository entry points, and documentation-bearing
source and workflow files. Material claims were traced to implementation,
schemas, tests, generated files, package metadata, or canonical evidence.

No daemon, provider, subscription, OAuth, SSH, Docker, package-install, or other
product workflow was executed. Findings that require those workflows are not
marked Verified. Accessibility and web UX were assessed from source only; no
claim is made about computed layout, contrast, browser behavior, or assistive
technology behavior that cannot be established from source.

### Convergence standard

An edit is required only when it has a concrete accuracy, task-success, safety,
consistency, accessibility, trust, discoverability, or maintenance benefit.
Accurate and usable prose is Good enough even when another rewrite is possible.
Humanizer-style patterns affect scoring only when they make writing less clear,
credible, precise, or natural.

This report separates:

- **Defects**, which reduce scores and require repair;
- **Improvement opportunities**, which do not affect readiness;
- **Good-enough material**, which should not be rewritten without new evidence.

## Executive verdict

**Verdict: Do not ship**

**Overall score: 41/100**

### Automatic gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Unresolved Critical defect | Failed | `DOC-C00`, `DOC-C01`, `DOC-C02` |
| Primary onboarding path | Failed | The recommended installer URL redirects to the latest package release, currently `@velum-labs/routekit-tracing@0.18.1`, where `install.sh` is absent. |
| Safe security guidance | Failed | `SECURITY.md` describes obsolete packages, components, and a stale supported line. |
| Support or billing claims | Failed | Current public support language conflicts with the canonical all-pending L06 evidence and the public disclosure page is absent. |

The numerical score is below 75, and two automatic gates independently require
`Do not ship`.

### Executive diagnosis

RouteKit's public documentation site has a strong modern structure. The
quickstart, installation guide, task-oriented guides, command reference,
configuration reference, privacy page, machine-readable Markdown routes, and
agent manifests form a better documentation system than the repository's other
surfaces. Much of this content is concise, direct, and already Good enough.

Release readiness is blocked by a broken primary journey and cross-surface
integrity rather than by the basic shape of the portal:

1. The recommended installation command returns `404`, because GitHub resolves
   the repository's latest release to a fixed-group package release that does not
   carry the RouteKit installer asset.
2. `SECURITY.md` still describes an earlier multi-product repository, says the
   supported line is `0.8.x`, and names Python/Fusion surfaces that are not in
   the current workspace.
3. The documentation policy says public route qualification comes only from the
   canonical L06 evidence, which marks every route pending. Current onboarding
   nevertheless uses unqualified “supported” language, and the public routes,
   billing, egress, failover, and limitations page was removed.
4. Six packages have no README despite the repository publishing five of them,
   existing package READMEs contain stale directory names, and symbol-level API
   documentation is local-only, sparsely authored, and generated with TypeDoc
   error checking disabled.
5. Contributor requirements disagree about the effective Node floor and cite a
   dependency that is no longer present.
6. Changelog generation is synchronized but not consistently useful: 88 of 442
   package version sections are empty and at least 23 entries say only
   “improvements.”

### Highest-priority actions

1. Make the recommended installer URL stable and add a release-level check that
   downloads the exact documented URL after every package release.
2. Replace `SECURITY.md` with a RouteKit-only policy tied to the current package
   line and current trust boundaries.
3. Restore an authoritative public route-disclosure surface or remove/prominently
   qualify every support claim until L06 closes; repair its broken mirrors and
   links.
4. Establish the package documentation contract: README for every workspace
   package, correct paths and support status, useful export examples, and a
   deliberate TypeDoc/JSDoc policy.
5. Make one source authoritative for the repository Node and pnpm floor, then
   check all contributor surfaces against it.
6. Define whether dependency-only and no-change package releases should produce
   empty changelog sections; suppress or annotate them consistently.

## Scores

### Overall rubric

| Dimension | Weight | Score (0–4) | Weighted result | Rationale |
| --- | ---: | ---: | ---: | --- |
| Factual integrity | 16 | 0.75 | 3.00 | The recommended installer is broken, and critical security and qualification claims are stale or inconsistent. |
| Task success | 14 | 1.0 | 3.50 | The primary installation command fails before setup can begin. |
| Coverage and completeness | 10 | 2.0 | 5.00 | The public portal is broad; package, security, route disclosure, and API coverage are incomplete. |
| Information architecture | 9 | 2.5 | 5.63 | Public IA is sound, but the removed disclosure page and split maintainer mirrors create dead ends. |
| Reference precision | 9 | 1.25 | 2.81 | Command/config references are strong; the installer URL, package paths, Node floor, security scope, and support terminology are not. |
| Audience fitness | 8 | 2.0 | 4.00 | The main new-user path is broken; operators, contributors, and package consumers also lack dependable entry points. |
| Safety, security, and privacy | 8 | 1.0 | 2.00 | Privacy guidance is strong, but the security policy itself is materially obsolete. |
| Operations and recovery | 7 | 2.5 | 4.38 | Troubleshooting, remote, and operations guides are practical, but the recommended installer does not resolve. |
| Cross-surface consistency | 5 | 1.0 | 1.25 | Public, maintainer, package, security, and toolchain surfaces disagree. |
| Clarity and usability | 5 | 3.0 | 3.75 | Public prose is generally concise and natural; internal and generated surfaces vary widely. |
| Web UX and accessibility | 4 | 3.25 | 3.25 | Source shows good semantics and responsive intent; one focus-management issue remains and rendered QA was out of scope. |
| Machine consumption | 2 | 2.5 | 1.25 | Markdown routes, `llms.txt`, and manifests are strong, but one prompt URL and one publish-path check are fragile. |
| Maintainability | 3 | 1.25 | 0.94 | Several generators and contract tests exist, but the installer release alias, high-risk entry points, and mirrors can drift silently. |
| **Total** | **100** |  | **40.75** | Rounded overall score: **41/100**. |

### Documentation surfaces

| Surface | Score | Readiness | Automatic gate | Summary |
| --- | ---: | --- | --- | --- |
| Public authored documentation | 48 | Do not ship | Broken onboarding, support claim | Strong structure, but the recommended installer fails and the route qualification boundary is missing. |
| Website source and accessibility | 83 | Ship with conditions | None | Good semantic structure; source-only review and one focus issue prevent Ship. |
| Repository entry points and security | 24 | Do not ship | Broken onboarding, security policy | The CLI README repeats the broken installer; the root README is too thin and the security policy is obsolete. |
| Maintainer docs and evidence | 58 | Do not ship | Support claim | Evidence mechanics are strong; mirrors and current-status boundaries disagree. |
| Package documentation and API docs | 42 | Do not ship | None | Missing READMEs, stale paths, and insufficient symbol-level guidance. |
| Specifications | 68 | Do not ship | None | Most specs are useful machine contracts; legacy local-model material lacks lifecycle status. |
| CLI help and agent manifests | 86 | Ship with conditions | None | Broad, structured, and test-backed; publish-path freshness can be stronger. |
| Changelogs and release documentation | 49 | Do not ship | Broken onboarding | The latest-release alias can select a package release without installer assets; many package histories are also empty or vague. |
| Contributor and release operations | 55 | Do not ship | Broken onboarding | Detailed operations docs exist, but release aliasing, toolchain, and docs-maintenance contracts drift. |

### Audiences

| Audience | Priority | Score | Readiness | Primary risks |
| --- | ---: | ---: | --- | --- |
| New RouteKit users | 1 | 34 | Do not ship | The recommended installer returns 404; support language and the repository entry point also drift. |
| Coding-agent users | 2 | 38 | Do not ship | The agent-led path points to a guide whose recommended installer fails, plus a hardcoded deployment URL and support-boundary drift. |
| Team and platform operators | 3 | 48 | Do not ship | Obsolete security scope and missing public route/billing disclosure. |
| AI agents and machine consumers | 4 | 58 | Do not ship | Good manifests and Markdown, but the executable first step fails, origin handling is fragile, and support truth is incomplete. |
| OpenAI-compatible API integrators | 5 | 70 | Do not ship | HTTP details are useful; route qualification, billing, and limitations are not centrally disclosed. |
| Contributors and maintainers | 6 | 54 | Do not ship | Toolchain contradictions, stale mirrors, thin root README, and legacy specs. |
| TypeScript package consumers | 7 | 37 | Do not ship | Published packages lack standalone guidance and carry no coherent public API documentation. |

## Defects

### Critical

#### DOC-C00 — The recommended installer URL returns 404

- **Classification:** Defect
- **Severity:** Critical
- **Confidence:** Verified
- **Surfaces:** Quickstart, installation guide, CLI package README, release workflow
- **Audiences:** New users, coding-agent users, operators
- **Journeys:** Installation and first success
- **Evidence:** `apps/docs/content/docs/getting-started/quickstart.mdx:26`,
  `apps/docs/content/docs/getting-started/installation.mdx:19`, and
  `packages/cli/README.md:10` all recommend
  `https://github.com/velum-labs/routekit/releases/latest/download/install.sh`.
  On August 3, 2026, GitHub redirected that URL to
  `/releases/download/@velum-labs/routekit-tracing@0.18.1/install.sh`, which
  returned `404`. `.github/workflows/release-packages.yml:85`–`109` identifies
  the RouteKit CLI tag separately, and `:123`–`137` uploads `install.sh` only to
  that tag. The repository's latest release can therefore be another fixed-group
  package release without the asset.
- **Authority:** GitHub release redirect observed during final safe-link
  validation; release workflow and Changesets fixed-group configuration
- **Impact:** The primary quickstart fails at step one for every user following
  the recommended installation path. This is an automatic release blocker.
- **Remediation:** Publish a stable installer URL that cannot be captured by an
  unrelated package release. Options include a dedicated unversioned download
  endpoint, a stable `routekit-latest` release, a docs-domain redirect resolved
  from the CLI package tag, or ensuring the repository's latest release always
  carries the installer. Update all three documented commands only after the new
  URL is live.
- **Dependencies:** Release-channel ownership decision; may require changing
  GitHub release creation rather than documentation alone.
- **Effort:** M
- **Acceptance criteria:** The exact documented URL returns a non-empty, expected
  installer for the current RouteKit CLI release regardless of which other
  workspace package released most recently; checksum/provenance behavior remains
  intact.
- **Validation:** After each release, fetch the exact documented URL, assert HTTP
  200, verify the expected script digest or markers, and run its non-mutating
  `--dry-run` path in CI.

#### DOC-C01 — Security policy describes the wrong product and release line

- **Classification:** Defect
- **Severity:** Critical
- **Confidence:** Strong
- **Surfaces:** Repository entry points, security, release support
- **Audiences:** All users; especially operators and security reviewers
- **Journeys:** Vulnerability triage, supported-version assessment, supply-chain review
- **Evidence:** `SECURITY.md:5` says “RouteKit and RouteKit”; `SECURITY.md:6`
  names `@routekit/*` packages and internal PyPI sidecars; `SECURITY.md:8` says
  the current supported line is `0.8.x`; `SECURITY.md:25` duplicates the CLI;
  `SECURITY.md:26`–`SECURITY.md:30` describe Fusion, Python synthesis, governance
  packages, and session backends absent from the current workspace;
  `SECURITY.md:38` and `SECURITY.md:53` repeat obsolete product and PyPI claims.
  Current package metadata is `0.18.1` and the workspace contains only the
  `@velum-labs/routekit*` package family.
- **Authority:** `packages/*/package.json`, `package.json`, current workspace
  layout, current runtime packages
- **Impact:** Readers cannot determine which versions receive security fixes or
  which components are in scope. This is a materially false security-support
  claim and an automatic release blocker.
- **Remediation:** Rewrite the policy around the current RouteKit CLI, daemon,
  gateway, provider/account routing, coding-tool integrations, installer,
  release artifacts, docs site, and current npm packages. Define the supported
  version policy without hardcoding a stale minor line unless automation updates
  it. Remove nonexistent PyPI/Fusion/governance statements. Link to the public
  privacy page as well as maintainer detail where appropriate.
- **Dependencies:** Decide whether security fixes support only the latest release
  or a maintained minor window.
- **Effort:** M
- **Acceptance criteria:** Every named package and subsystem exists; the support
  line matches release policy; vulnerability reporting remains private and
  actionable; a contract check prevents obsolete namespaces and stale hardcoded
  versions.
- **Validation:** Compare all package names to workspace manifests; add a test
  rejecting retired product terms and stale fixed release lines.

#### DOC-C02 — Public support claims bypass the canonical qualification contract

- **Classification:** Defect
- **Severity:** Critical
- **Confidence:** Strong
- **Surfaces:** Public docs, maintainer docs, package README, qualification evidence
- **Audiences:** New users, coding-tool users, operators, API integrators, AI agents
- **Journeys:** Provider selection, subscription enrollment, billing review, tool launch
- **Evidence:** `docs/public-documentation-maintenance.md:47`–`57` says public
  qualification comes only from `docs/routekit-l06-evidence.json` and that a
  deterministic pass cannot promote a route while live/manual outcomes are
  pending. Every route in that JSON is currently `pending`. In contrast,
  `apps/docs/content/docs/index.mdx:3`, `index.mdx:48`, and `index.mdx:59` use
  “supported” without the planned/pending boundary; `getting-started/quickstart.mdx:8`
  says “supported API-provider credential”; and
  `getting-started/installation.mdx:70` calls provider IDs supported starters.
  The former public disclosure page
  `apps/docs/content/docs/reference/routes-and-billing.mdx` is absent from the
  current tree, while `docs/routekit-routes-and-billing.md:5` and
  `packages/cli/README.md:161` still link to it. The maintainer mirror also
  contains route-level “L06 Pass” language while the canonical qualification
  status remains pending.
- **Authority:** `spec/routekit/l06-evidence.json`, generated
  `docs/routekit-l06-evidence.json`, `spec/routekit/l06-evidence-map.json`, and the
  repository's own evidence policy
- **Impact:** Users can reasonably infer that routes, billing paths, and provider
  behavior carry a support commitment that the canonical evidence explicitly
  withholds. They also cannot find one current public source for credentials,
  egress, billing, failover, limitations, and qualification state. This is a
  materially false support claim and an automatic release blocker.
- **Remediation:** Choose one explicit contract and apply it everywhere. The
  lower-risk repair is to restore a generated or tightly checked public route
  disclosure, label all six first-launch routes Planned/Pending until L06 closes,
  distinguish implemented behavior from qualified support, and replace loose
  “supported” language with accurate terms. If the product policy has changed,
  update the canonical evidence policy and evidence—not only the prose.
- **Dependencies:** Product decision on the meaning of “supported” versus
  “implemented,” and whether L06 remains the release gate.
- **Effort:** L
- **Acceptance criteria:** One public disclosure covers every first-launch route;
  every support claim agrees with canonical evidence; no broken route-disclosure
  links remain; tests compare route status, version, revision, and evidence state
  across public and maintainer surfaces.
- **Validation:** Run L06 generation/checks, docs-contract tests, relative-link
  checks, and a search for unqualified `supported`/`qualified` route language.

### Major

#### DOC-M01 — Workspace packages do not meet the standalone README contract

- **Classification:** Defect
- **Severity:** Major
- **Confidence:** Verified
- **Surfaces:** Package docs, npm entry points, contributor docs
- **Audiences:** TypeScript package consumers, contributors
- **Journeys:** Package selection, import, extension, testing, maintenance
- **Evidence:** These packages have no README:
  `packages/cli-core`, `packages/config-core`, `packages/router`,
  `packages/telemetry-core`, `packages/testkit`, and `packages/tracing`. All except
  testkit are publishable packages. Existing READMEs also contain stale directory
  paths: `packages/cli/README.md:3`, `packages/cli/README.md:58`, and
  `packages/config/README.md:3` name nonexistent `packages/routekit-*` directories.
- **Authority:** `packages/*/package.json`, current `packages/*` directories,
  public export entry points
- **Impact:** Package consumers cannot determine intended use, stability, primary
  exports, examples, or support status from the package itself. Contributors are
  directed to paths that do not exist.
- **Remediation:** Give every workspace package a concise README with purpose,
  public/internal status, import examples, important exports, invariants, and
  links to the nearest maintained reference. Correct stale directory names in
  existing READMEs. Enforce README presence for every workspace package.
- **Dependencies:** Decide the intended support status of each published package.
- **Effort:** L
- **Acceptance criteria:** Every workspace package has a useful README; every path
  exists; published packages state compatibility expectations; examples compile
  or are checked where practical.
- **Validation:** Add a repository invariant for README presence and a relative
  path checker for package docs.

#### DOC-M02 — Symbol-level API documentation is not reliable enough for the exported surface

- **Classification:** Defect
- **Severity:** Major
- **Confidence:** Strong
- **Surfaces:** Exported JSDoc, TypeDoc, API status, package map
- **Audiences:** Contributors, TypeScript package consumers
- **Journeys:** Discovering exports, embedding RouteKit, extending packages
- **Evidence:** `typedoc.json:4`–`27` exposes 23 package entry points, including
  private testkit, while `typedoc.json:35` disables TypeDoc error checking.
  `apps/docs/content/docs/reference/api.mdx:15`–`24` says output is gitignored,
  local-only, and unpublished. Several entry points export broad APIs with little
  adjacent JSDoc, including `packages/config-core/src/index.ts`,
  `packages/telemetry-core/src/index.ts`, `packages/tracing/src/index.ts`, and
  `packages/testkit/src/index.ts`. The package map points readers to source files
  rather than a maintained symbol contract.
- **Authority:** Package exports and TypeScript declarations
- **Impact:** Generated pages can exist without being accurate, explanatory, or
  build-checked. Consumers must infer behavior and invariants from source.
- **Remediation:** Decide whether exported packages are supported APIs or
  explicitly internal building blocks. For either policy, document exported
  contracts proportionately: add JSDoc to non-obvious public symbols, generate
  TypeDoc with error checking, exclude irrelevant private surfaces, and make the
  generated output discoverable to its intended audience.
- **Dependencies:** Package support-policy decision from `DOC-M01`.
- **Effort:** XL
- **Acceptance criteria:** Every generated entry point has an intended audience;
  non-obvious exports have useful descriptions and examples; generation fails on
  unresolved type/doc errors; package READMEs link to the correct output.
- **Validation:** Generate TypeDoc without `skipErrorChecking`; inspect warnings;
  add a documented-export coverage policy rather than a raw percentage target.

#### DOC-M03 — Repository onboarding does not serve either users or contributors

- **Classification:** Defect
- **Severity:** Major
- **Confidence:** Strong
- **Surfaces:** Root README, repository landing
- **Audiences:** New users, contributors, package consumers
- **Journeys:** First repository visit, installation, source setup, architecture orientation
- **Evidence:** `README.md` is 14 lines. It immediately runs source-development
  commands without prerequisites, does not link to the public installation or
  quickstart, does not identify supported platforms, does not explain the daemon
  or authentication boundary, and says only “See `docs/`.” The public
  installation guide already contains a usable product path, and
  `docs/repository-reference.md` contains the contributor context that the root
  entry point omits.
- **Authority:** Public installation/quickstart, package metadata, repository reference
- **Impact:** Product users can mistake source compilation for installation;
  contributors lack Node/Corepack requirements and a map to the right documents.
- **Remediation:** Make the root README a short routing page with separate
  “Install RouteKit” and “Develop from source” paths, product summary, support
  boundary, canonical docs links, requirements, and top-level verification.
- **Dependencies:** Resolve `DOC-M04` before publishing source prerequisites.
- **Effort:** M
- **Acceptance criteria:** A first-time visitor can choose product or contributor
  setup without knowing the repository layout; commands have prerequisites and
  next steps; links use canonical destinations.
- **Validation:** Static link check and manual source review against the public
  quickstart and repository reference.

#### DOC-M04 — Contributor toolchain requirements contradict package metadata

- **Classification:** Defect
- **Severity:** Major
- **Confidence:** Strong
- **Surfaces:** `AGENTS.md`, repository reference, source-development guide, package metadata
- **Audiences:** Contributors, coding agents, CI maintainers
- **Journeys:** Dependency installation, environment diagnosis
- **Evidence:** `package.json:9` declares Node `>=22.0.0`. `AGENTS.md:12`–`19`,
  `docs/repository-reference.md:28`, and
  `apps/docs/content/docs/guides/source-development.mdx:11` assert `>=22.19.0`
  because `undici@8.5.0` requires it. The current lockfile contains no
  `undici@8.5.0` package; it contains only `undici-types`. `AGENTS.md` additionally
  describes a VM-specific `/exec-daemon/node` version that is not a portable
  repository requirement.
- **Authority:** `package.json` engines, current lockfile, `.npmrc`, pinned package manager
- **Impact:** Contributors and agents can reject a valid Node 22 environment or
  follow obsolete VM recovery instructions. Future drift is likely because the
  effective floor is duplicated in prose.
- **Remediation:** Make `package.json` the single Node/pnpm contract. If the real
  floor is above 22.0.0, update the engine and add a checked explanation. Move
  ephemeral VM details out of repository-wide instructions or label them as
  environment-specific and current only when verified.
- **Dependencies:** Confirm the oldest Node version the repository intentionally supports.
- **Effort:** S
- **Acceptance criteria:** All contributor surfaces state the same checked floor;
  no absent dependency is cited; environment-specific recovery is clearly scoped.
- **Validation:** Add a test comparing documented toolchain values with
  `package.json` and the pinned package manager.

### Moderate

#### DOC-O01 — Route and documentation maintenance mirrors can drift silently

- **Classification:** Defect
- **Severity:** Moderate
- **Confidence:** Verified
- **Surfaces:** Documentation maintenance, package README, maintainer route docs
- **Audiences:** Maintainers, reviewers
- **Journeys:** Documentation release, route-policy update
- **Evidence:** `docs/public-documentation-maintenance.md:17`–`19` still names
  “routes and billing” as a public target and `:95` still requires inspecting it.
  `docs/routekit-routes-and-billing.md:5` and `packages/cli/README.md:161` link to
  the deleted file. Existing checks found no public-route miss because the broken
  links are repository-relative, outside the public MDX tree.
- **Authority:** Current file tree, navigation metadata, docs generation/check scripts
- **Impact:** Maintainers can follow a checklist that cannot be completed, while
  normal docs builds remain green.
- **Remediation:** Repair after the product decision in `DOC-C02`; expand link
  validation to all repository Markdown and make the source-of-truth matrix
  mechanically verifiable where practical.
- **Dependencies:** `DOC-C02`
- **Effort:** M
- **Acceptance criteria:** No configured documentation surface links to a missing
  source; the release checklist names only current pages; mirrors have an owner
  or generator.
- **Validation:** Repository-wide internal-link and source-matrix check.

#### DOC-O02 — Legacy local-model specification lacks lifecycle status and current ownership

- **Classification:** Defect
- **Severity:** Moderate
- **Confidence:** Strong
- **Surfaces:** Specifications, registry package, operations docs
- **Audiences:** Contributors, maintainers, package consumers
- **Journeys:** Registry maintenance, local-model feature discovery
- **Evidence:** `spec/registry/local-catalog.json:2` describes a hardware-aware
  Apple Silicon catalog, “defaultTrioFor,” a standalone model-gateway fallback,
  “panel” members, and “judges.” The generated registry still exports this data
  through `packages/registry/src/index.ts:257`–`266`, but no current RouteKit
  product documentation explains whether the feature is implemented, retained,
  deprecated, or external-only. The spec has no lifecycle status.
- **Authority:** Current runtime consumers, registry exports, RouteKit product scope
- **Impact:** Maintainers can treat inherited registry data as a current RouteKit
  product contract, and package consumers see unexplained public exports.
- **Remediation:** Declare the spec implemented, retained, deprecated, or planned.
  If retained for compatibility, label and isolate it. If current, document its
  owning product surface and user workflow. If unused, remove it and its exports
  through the normal compatibility process.
- **Dependencies:** Product ownership decision.
- **Effort:** M
- **Acceptance criteria:** The file's lifecycle and consumer are explicit; prose
  uses current terminology; exports and docs agree.
- **Validation:** Search generated bindings and runtime imports; add a status field
  or adjacent maintained reference.

#### DOC-O03 — Package changelogs are synchronized but often not informative

- **Classification:** Defect
- **Severity:** Moderate
- **Confidence:** Verified
- **Surfaces:** All package changelogs, release history
- **Audiences:** Package consumers, maintainers, security reviewers
- **Journeys:** Upgrade assessment, regression investigation, release review
- **Evidence:** Across 23 package changelogs there are 442 version sections. 88
  are empty. `packages/cli-ui/CHANGELOG.md`, `packages/registry/CHANGELOG.md`,
  `packages/runtime/CHANGELOG.md`, and `packages/tracing/CHANGELOG.md` each contain
  18 empty version sections; `packages/contracts/CHANGELOG.md` contains 16. At
  least 23 entries use the description “improvements.” The generated public CLI
  changelog is substantially more useful, which shows the problem is concentrated
  in package histories rather than all release documentation.
- **Authority:** Changesets configuration, package changesets, package manifests
- **Impact:** Consumers cannot tell whether an empty version is an intentional
  fixed-group bump, a dependency-only release, or missing release notes.
- **Remediation:** Document the fixed-group changelog policy. Suppress empty
  sections if tooling allows, or annotate them as version-alignment/no direct
  package changes. Reject vague changeset summaries before merge.
- **Dependencies:** Changesets workflow decision.
- **Effort:** L
- **Acceptance criteria:** New changelog sections communicate direct,
  dependency-only, or alignment-only changes; no new “improvements” summaries;
  historical normalization is either completed or explicitly deferred.
- **Validation:** Add changeset summary lint and a changelog quality check for
  empty sections.

#### DOC-O04 — Agent-first setup hardcodes one deployment hostname

- **Classification:** Defect
- **Severity:** Moderate
- **Confidence:** Strong
- **Surfaces:** Public quickstart component, machine-consumption path
- **Audiences:** New users, coding-agent users, AI agents
- **Journeys:** Copying the agent setup prompt
- **Evidence:** `apps/docs/src/components/agent-setup-prompt.tsx:6`–`12`
  hardcodes `https://routekit-docs-velum-labs.vercel.app/...`. The rest of the
  app resolves canonical and preview origins through
  `apps/docs/src/lib/site-url.ts:1`–`10` and `NEXT_PUBLIC_DOCS_URL`.
- **Authority:** Site URL configuration and deployment metadata
- **Impact:** A custom domain, preview, fork, or future deployment migration can
  make the copied prompt point at a different or obsolete documentation build.
- **Remediation:** Derive the URL from the configured canonical origin on the
  server, or construct a same-origin absolute URL at interaction time. Keep the
  Markdown route.
- **Dependencies:** None
- **Effort:** S
- **Acceptance criteria:** Copied prompts always reference the active canonical
  documentation origin; previews do not silently copy production-host assumptions.
- **Validation:** Component test with canonical, preview, and local origins.

#### DOC-O05 — Agent manifest freshness is not part of the documentation build contract

- **Classification:** Defect
- **Severity:** Moderate
- **Confidence:** Strong
- **Surfaces:** Generated command/error manifests, manual docs publishing
- **Audiences:** AI agents, maintainers
- **Journeys:** Structured command lookup, manual documentation release
- **Evidence:** `packages/cli/src/test/docs-contract.test.ts:263`–`273` checks the
  manifests during the CLI test suite. `apps/docs/package.json:9`–`12` checks the
  public changelog, `llms.txt`, model references, MDX, TypeScript, and Next build,
  but not agent manifests. `.github/workflows/publish-docs.yml:24`–`56` delegates
  directly to Vercel and does not run the CLI test suite before manual promotion.
- **Authority:** Manifest generator, docs build scripts, publish workflows
- **Impact:** A manual docs-only publication can promote stale command or error
  JSON even when the human docs build succeeds.
- **Remediation:** Add a `--check` manifest step to docs build/publish after the
  CLI is built, or generate manifests as part of the staged build and fail on a
  dirty diff.
- **Dependencies:** Build-time cost decision.
- **Effort:** S
- **Acceptance criteria:** Both release and manual docs publication prove the
  committed manifests match the current command and error contracts.
- **Validation:** Change a command description in a fixture and confirm both docs
  publication paths fail until manifests are regenerated.

### Minor

#### DOC-N01 — Feedback dialog does not restore or contain keyboard focus

- **Classification:** Defect
- **Severity:** Minor
- **Confidence:** Strong
- **Surfaces:** Website source and accessibility
- **Audiences:** Keyboard and assistive-technology users
- **Journeys:** Reporting selected-text documentation feedback
- **Evidence:** `apps/docs/src/components/feedback-popover.tsx:163`–`165` focuses
  the textarea when the dialog opens, and `:145`–`147` supports Escape. On
  dismissal, the selected-text trigger is removed and focus is not restored to a
  stable element. The custom `role="dialog"` does not contain Tab navigation.
- **Authority:** Component source and WAI-ARIA dialog interaction expectations
- **Impact:** Keyboard focus can be lost or move unpredictably after dismissal.
- **Remediation:** Use a maintained accessible dialog/popover primitive or record
  and restore focus to a stable page target. If the panel is intentionally
  non-modal, document and implement its focus behavior explicitly.
- **Dependencies:** None
- **Effort:** S
- **Acceptance criteria:** Opening, tabbing through, escaping, clicking outside,
  and sending all leave focus in a predictable location.
- **Validation:** Component keyboard test; rendered assistive-technology QA during repair.

#### DOC-N02 — Existing package READMEs overuse unsupported “canonical” claims

- **Classification:** Defect
- **Severity:** Minor
- **Confidence:** Subjective
- **Surfaces:** Package READMEs
- **Audiences:** Contributors, package consumers
- **Journeys:** Understanding package ownership
- **Evidence:** Several READMEs repeatedly call packages, drivers, registries, or
  contracts “canonical” without naming the competing sources they replace or the
  invariant that makes the claim useful, for example
  `packages/tool-registry/README.md:3`, `packages/tool-opencode/README.md:3`, and
  `packages/tools/README.md:3`–`11`.
- **Authority:** Actual dependency ownership and repository invariants
- **Impact:** The wording sounds promotional or absolute and does not always help
  a reader choose the correct extension point.
- **Remediation:** Keep “canonical” only where the document names the uniqueness
  invariant or source-of-truth role. Prefer direct ownership statements elsewhere.
- **Dependencies:** Package README work in `DOC-M01`.
- **Effort:** S
- **Acceptance criteria:** Remaining uses explain what is unique and how drift is prevented.
- **Validation:** Human review using the agreed direct, precise writing standard.

## Improvement opportunities

These items do not reduce readiness scores and should not be repaired before the
defects above unless they are naturally included in the same change.

1. Add a compact architecture diagram or process summary to the root README after
   it has distinct product and contributor paths.
2. Add examples of expected JSON shapes to the HTTP guide for `/v1/models` and
   one error response. Existing request examples are already sufficient for first
   success.
3. Add per-page “last contract review” metadata only if it can be generated from
   source ownership or release triggers. Do not add manual freshness dates that
   become another drift surface.
4. Consider generating package README export tables from TypeScript only after
   the public/internal package policy is settled. Generated lists without
   explanations would not solve `DOC-M02`.
5. Consider a compact support-status badge in public provider/tool pages after
   the qualification model is repaired.

## Good-enough examples

The following material should not be rewritten merely for stylistic preference:

- `apps/docs/content/docs/getting-started/quickstart.mdx` has a clear end state,
  prerequisites, numbered steps, expected output, and next actions. Repair its
  support terminology without redesigning the page.
- `apps/docs/content/docs/getting-started/installation.mdx` separates the
  recommended installer, npm, deterministic automation, updates, and headless
  setup. Its platform boundary is explicit.
- `apps/docs/content/docs/reference/commands.mdx` and
  `apps/docs/content/docs/reference/configuration.mdx` are detailed, scannable,
  and backed by substantial contract tests. Fix only evidence-backed drift.
- `apps/docs/content/docs/concepts/privacy.mdx` and
  `docs/telemetry-inventory.md` state storage, credentials, egress, telemetry,
  and redaction boundaries concretely.
- `apps/docs/content/docs/guides/remote-gateway.mdx`,
  `apps/docs/content/docs/guides/troubleshooting.mdx`, and
  `apps/docs/content/docs/guides/operations.mdx` use task-focused structures and
  practical verification commands.
- `spec/registry/providers.json`, `spec/registry/subscriptions.json`, and
  `spec/routekit/supported-clients.json` contain useful machine-readable comments
  and ownership metadata.
- `apps/docs/public/agent/commands.json`, `errors.json`, and `llms.txt` provide a
  strong machine-consumption layer once freshness and qualification truth are fixed.
- The web application source generally uses semantic links, buttons, nav labels,
  decorative-image alternatives, strict Mermaid rendering, and visible focus
  styles. Do not redesign it without rendered evidence.

## Findings indexes

### By documentation surface

| Surface | Findings |
| --- | --- |
| Public documentation | `DOC-C00`, `DOC-C02`, `DOC-O01`, `DOC-O04` |
| Repository entry points | `DOC-C00`, `DOC-C01`, `DOC-M03`, `DOC-M04` |
| Maintainer docs and evidence | `DOC-C02`, `DOC-O01`, `DOC-O02` |
| Package READMEs | `DOC-C02`, `DOC-M01`, `DOC-M02`, `DOC-N02` |
| Specifications | `DOC-C02`, `DOC-O02` |
| Generated agent artifacts | `DOC-C02`, `DOC-O04`, `DOC-O05` |
| Changelogs and releases | `DOC-C00`, `DOC-C01`, `DOC-O03` |
| Website source/accessibility | `DOC-N01` |

### By user journey

| Journey | Findings |
| --- | --- |
| Install and first success | `DOC-C00`, `DOC-C02`, `DOC-M03`, `DOC-M04`, `DOC-O04` |
| Select a provider or subscription | `DOC-C02` |
| Understand billing, egress, and failover | `DOC-C02`, `DOC-O01` |
| Review security support | `DOC-C01` |
| Develop from source | `DOC-M03`, `DOC-M04` |
| Consume or extend packages | `DOC-M01`, `DOC-M02`, `DOC-O02`, `DOC-N02` |
| Upgrade and assess releases | `DOC-C01`, `DOC-O03` |
| Use documentation from an AI agent | `DOC-C02`, `DOC-O04`, `DOC-O05` |
| Report a documentation issue | `DOC-N01` |

## Remediation plan

### Release blockers

| Order | Finding | Deliverable | Effort | Depends on |
| ---: | --- | --- | --- | --- |
| 1 | `DOC-C00` | Stable installer channel and end-to-end release check | M | Release-channel ownership decision |
| 2 | `DOC-C01` | Current RouteKit security policy and drift guard | M | Security support-window decision |
| 3 | `DOC-C02` | Restored qualification/disclosure contract and consistent support language | L | Product definition of supported vs implemented |

### Near-term repairs

| Order | Finding | Deliverable | Effort | Depends on |
| ---: | --- | --- | --- | --- |
| 4 | `DOC-O01` | Repository-wide internal-link validation and current maintenance matrix | M | `DOC-C02` |
| 5 | `DOC-M04` | One checked toolchain requirement | S | Node support decision |
| 6 | `DOC-M03` | Product/contributor root README | M | `DOC-M04` |
| 7 | `DOC-O04` | Canonical-origin agent prompt | S | None |
| 8 | `DOC-O05` | Agent-manifest check in docs publication | S | None |
| 9 | `DOC-N01` | Predictable feedback focus behavior | S | None |

### Structural work

| Order | Finding | Deliverable | Effort | Depends on |
| ---: | --- | --- | --- | --- |
| 10 | `DOC-M01` | README for every workspace package and path checks | L | Package support policy |
| 11 | `DOC-M02` | Supported/internal API contract, JSDoc policy, checked TypeDoc | XL | `DOC-M01` |
| 12 | `DOC-O02` | Local-model spec lifecycle and ownership decision | M | Product ownership decision |
| 13 | `DOC-O03` | Useful fixed-group changelog policy and lint | L | Release workflow decision |

### Optional improvements

Apply only after the corpus reaches Ship or Ship with conditions. Stop when all
Defects are closed or explicitly accepted and the remaining list consists only
of improvement opportunities.

## Document inventory

The inventory records document-level status. “Good enough” does not mean perfect;
it means no independent defect warrants an edit outside the linked systemic work.

### Public authored pages

| Path | Audience and purpose | Authority/freshness | Audit result | Findings |
| --- | --- | --- | --- | --- |
| `apps/docs/content/docs/index.mdx` | New-user overview | Current worktree; product docs | Defect | `DOC-C02` |
| `apps/docs/content/docs/getting-started/quickstart.mdx` | First success | CLI/setup implementation and tests | Critical defect; structure Good enough | `DOC-C00`, `DOC-C02` |
| `apps/docs/content/docs/getting-started/installation.mdx` | Installation and deterministic setup | Installer, config, self-update implementation | Critical defect; structure Good enough | `DOC-C00`, `DOC-C02` |
| `apps/docs/content/docs/getting-started/agent-guide.mdx` | Safe agent operating contract | CLI manifests and public guides | Defect | `DOC-C00`, `DOC-C02`, `DOC-O04` |
| `apps/docs/content/docs/guides/user-guide.mdx` | Workflow router | Current navigation and support docs | Defect | `DOC-C02` |
| `apps/docs/content/docs/guides/coding-tools.mdx` | Codex/Claude integration | Supported-client generator and launcher code | Good enough | — |
| `apps/docs/content/docs/guides/http-gateway.mdx` | API integration | Gateway routes and adapters | Good enough except shared support boundary | `DOC-C02` |
| `apps/docs/content/docs/guides/subscription-pooling.mdx` | Account pooling | Accounts/daemon implementation | Good enough except shared support boundary | `DOC-C02` |
| `apps/docs/content/docs/guides/aws-bedrock.mdx` | Bedrock operator setup | Registry, gateway, AWS behavior; qualification explicitly limited | Good enough | — |
| `apps/docs/content/docs/guides/remote-gateway.mdx` | Remote operator setup | CLI remote/install implementation | Good enough | — |
| `apps/docs/content/docs/guides/operations.mdx` | Health, usage, calls, logs | Control/daemon/CLI implementation | Good enough | — |
| `apps/docs/content/docs/guides/troubleshooting.mdx` | Recovery | CLI errors and common states | Good enough | — |
| `apps/docs/content/docs/guides/source-development.mdx` | Contributor setup | Package metadata and root scripts | Defect | `DOC-M04` |
| `apps/docs/content/docs/concepts/architecture.mdx` | Mental model | Daemon/router/gateway implementation | Good enough | — |
| `apps/docs/content/docs/concepts/privacy.mdx` | Credentials and data | Runtime paths, auth, telemetry | Good enough | — |
| `apps/docs/content/docs/concepts/subscription-routing.mdx` | Pool behavior | Accounts and provider routing | Good enough | — |
| `apps/docs/content/docs/reference/commands.mdx` | CLI lookup | Commander tree and docs-contract tests | Good enough | — |
| `apps/docs/content/docs/reference/configuration.mdx` | Schema lookup | Config schemas and registry | Good enough | — |
| `apps/docs/content/docs/reference/model-catalog.mdx` | Model selection | Registry and live discovery contracts | Good enough | — |
| `apps/docs/content/docs/reference/client-compatibility.mdx` | Exact client support | Generated supported-client spec | Good enough | — |
| `apps/docs/content/docs/reference/packages.mdx` | Package map | Workspace manifests and entry points | Defect | `DOC-M01`, `DOC-M02` |
| `apps/docs/content/docs/reference/api.mdx` | API support status | TypeDoc config and package policy | Defect | `DOC-M02` |
| `apps/docs/content/docs/changelog.mdx` | Public CLI release history | Generated from CLI changelog | Good enough | — |

Navigation metadata under `apps/docs/content/docs/**/meta.json` is current and
internally coherent, but it omits the route-disclosure destination required by
the documented evidence policy (`DOC-C02`, `DOC-O01`).

### Repository entry points and maintainer documents

| Path | Audience and purpose | Authority/freshness | Audit result | Findings |
| --- | --- | --- | --- | --- |
| `README.md` | Repository landing | Current scripts and public docs | Defect | `DOC-M03` |
| `SECURITY.md` | Security support/reporting | Current packages and support policy | Critical defect | `DOC-C01` |
| `AGENTS.md` | Agent/contributor environment | Package metadata and VM state | Defect | `DOC-M04` |
| `docs/repository-reference.md` | Maintainer orientation | Current architecture and scripts | Defect | `DOC-M04` |
| `docs/cli.md` | Maintainer CLI reference | Commander implementation | Good enough | — |
| `docs/configuration.md` | Maintainer config reference | Config schemas | Good enough | — |
| `docs/model-catalog.md` | Maintainer catalog reference | Registry/live discovery | Good enough | — |
| `docs/packages.md` | Maintainer package map | Workspace manifests | Defect | `DOC-M01`, `DOC-M02` |
| `docs/typescript-reference.md` | Maintainer export guide | Package entry points | Defect | `DOC-M01`, `DOC-M02` |
| `docs/testing.md` | Test architecture | Scripts and test suites | Good enough | — |
| `docs/operations-and-scripts.md` | Script/operator reference | Root scripts | Good enough except inherited spec status | `DOC-O02` |
| `docs/public-documentation-maintenance.md` | Docs release contract | Current public tree and checks | Defect | `DOC-C02`, `DOC-O01`, `DOC-O05` |
| `docs/aws-bedrock-setup.md` | Maintainer Bedrock runbook | Gateway and AWS setup | Good enough | — |
| `docs/subscription-pooling.md` | Maintainer account-pool behavior | Accounts and registry | Good enough | — |
| `docs/routekit-remote-gateways.md` | Maintainer remote runbook | CLI remote implementation | Good enough | — |
| `docs/routekit-e2e-matrix.md` | Verification matrix | E2E scripts | Good enough | — |
| `docs/telemetry-inventory.md` | Exact telemetry contract | Telemetry schemas and events | Good enough | — |
| `docs/routekit-supported-clients.md` | Generated client support | Supported-client spec | Good enough | — |
| `docs/routekit-routes-and-billing.md` | Maintainer route disclosure mirror | Canonical L06 evidence | Critical defect | `DOC-C02`, `DOC-O01` |
| `docs/routekit-l06-evidence.md` | Generated qualification rendering | Canonical L06 JSON | Good enough historical/current-status rendering | — |
| `docs/routekit-account-activation-evidence.md` | Immutable implementation evidence | Bound revision and tests | Good enough historical evidence | — |
| `docs/routekit-claude-recovery-evidence.md` | Immutable recovery evidence | Bound revision and tests | Good enough historical evidence | — |
| `docs/routekit-request-attribution-evidence.md` | Immutable attribution evidence | Bound revision and tests | Good enough historical evidence | — |
| `docs/routekit-route-info-evidence.md` | Immutable route-info evidence | Bound revision and tests | Good enough historical evidence | — |
| `docs/t3-routekit-deployment.md` | Internal deployment runbook | Deployment scripts | Good enough for declared internal audience | — |
| `docs/evidence/client-compatibility/2026-08-01-cursor-3.12.30.md` | Immutable client evidence | Date/version/revision bound | Good enough historical evidence | — |
| `docs/evidence/routekit-real-account/2026-07-22-dad16c53.md` | Immutable account qualification | Revision bound | Good enough historical evidence | — |
| `docs/reports/public-documentation-audit-2026-08-01.md` | Historical audit | Dated baseline and revision | Good enough historical report; superseded for current judgment | — |
| `docs/reports/t3-routekit-implementation-report-2026-08-01.md` | Historical implementation report | Dated revision/evidence | Good enough historical report | — |

### Package READMEs

| Package path | Audit result | Findings |
| --- | --- | --- |
| `packages/accounts/README.md` | Good enough | — |
| `packages/cli/README.md` | Critical installer defect plus stale paths and disclosure link | `DOC-C00`, `DOC-C02`, `DOC-M01`, `DOC-O01` |
| `packages/cli-core/README.md` | Missing | `DOC-M01` |
| `packages/cli-ui/README.md` | Good enough | — |
| `packages/config/README.md` | Defect: stale directory path | `DOC-M01` |
| `packages/config-core/README.md` | Missing | `DOC-M01` |
| `packages/contracts/README.md` | Good enough | — |
| `packages/control/README.md` | Good enough | — |
| `packages/daemon/README.md` | Good enough | — |
| `packages/gateway/README.md` | Good enough | — |
| `packages/harness-core/README.md` | Good enough | — |
| `packages/registry/README.md` | Defect: unexplained retained local-model surface | `DOC-O02` |
| `packages/router/README.md` | Missing | `DOC-M01` |
| `packages/runtime/README.md` | Good enough | — |
| `packages/telemetry-core/README.md` | Missing | `DOC-M01` |
| `packages/testkit/README.md` | Missing | `DOC-M01` |
| `packages/tool-claude/README.md` | Good enough | — |
| `packages/tool-codex/README.md` | Good enough | — |
| `packages/tool-cursor/README.md` | Good enough and appropriately limits support | — |
| `packages/tool-opencode/README.md` | Good enough | — |
| `packages/tool-registry/README.md` | Minor style defect | `DOC-N02` |
| `packages/tools/README.md` | Minor style defect | `DOC-N02` |
| `packages/tracing/README.md` | Missing | `DOC-M01` |

### Package changelogs

All 23 package changelogs are generated by Changesets and version-aligned. The
following inventory distinguishes useful direct/dependency history from files
dominated by empty sections:

| Changelog | Audit result | Findings |
| --- | --- | --- |
| `packages/accounts/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/cli/CHANGELOG.md` | Good enough; canonical public CLI history | — |
| `packages/cli-core/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/cli-ui/CHANGELOG.md` | 18 empty sections | `DOC-O03` |
| `packages/config/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/config-core/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/contracts/CHANGELOG.md` | 16 empty sections | `DOC-O03` |
| `packages/control/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/daemon/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/gateway/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/harness-core/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/registry/CHANGELOG.md` | 18 empty sections | `DOC-O03` |
| `packages/router/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/runtime/CHANGELOG.md` | 18 empty sections | `DOC-O03` |
| `packages/telemetry-core/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/testkit/CHANGELOG.md` | Dependency-only history is present but not explained | `DOC-O03` |
| `packages/tool-claude/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/tool-codex/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/tool-cursor/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/tool-opencode/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/tool-registry/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/tools/CHANGELOG.md` | Usable with one vague historical entry | `DOC-O03` |
| `packages/tracing/CHANGELOG.md` | 18 empty sections | `DOC-O03` |

### Specifications and generated evidence

| Path | Purpose | Audit result | Findings |
| --- | --- | --- | --- |
| `spec/registry/connectors.json` | Account connector contract | Good enough | — |
| `spec/registry/local-catalog.json` | Retained local MLX catalog | Defect: lifecycle unclear | `DOC-O02` |
| `spec/registry/model-capabilities.json` | Request/capability quirks | Good enough | — |
| `spec/registry/model-catalog.json` | Curated/fallback model catalog | Good enough | — |
| `spec/registry/pricing.json` | Approximate cost metadata | Good enough | — |
| `spec/registry/providers.json` | Provider metadata and discovery | Good enough | — |
| `spec/registry/subscriptions.json` | Subscription auth metadata | Good enough | — |
| `spec/routekit/l06-evidence-map.json` | Stable qualification mapping | Good enough | — |
| `spec/routekit/l06-evidence.json` | Canonical qualification evidence | Good enough; all routes pending | — |
| `spec/routekit/supported-clients.json` | Exact client support contract | Good enough | — |
| `docs/routekit-l06-evidence.json` | Generated public/maintainer JSON rendering | Good enough | — |

### Generated, source, and operational documentation families

| Surface | Audit result | Findings |
| --- | --- | --- |
| `apps/docs/public/llms.txt` and per-page `.md` routes | Strong machine discovery and context | `DOC-C02` shared truth only |
| `apps/docs/public/agent/commands.json` | Strong structured command contract | `DOC-O05` |
| `apps/docs/public/agent/errors.json` | Strong structured error/remediation contract | `DOC-O05` |
| `scripts/docs/agent-manifest-data.mjs` | Useful reviewed safety metadata | `DOC-O05` publish integration |
| `typedoc.json` and generated local TypeDoc | Incomplete contract and unchecked generation | `DOC-M02` |
| Exported JSDoc under `packages/*/src` | Uneven; strong in selected complex modules, sparse at many entry points | `DOC-M02` |
| `.github/actions/deploy-docs/action.yml` | Clear staged Vercel promotion | `DOC-O05` |
| `.github/workflows/publish-docs.yml` | Clear approval and branch gates | `DOC-O05` |
| `.github/workflows/release-packages.yml` | Detailed release pipeline | Good enough except shared security/changelog policy |
| `scripts/check-repo.mjs` | Strong repository invariants | Missing README/link/toolchain checks from findings |
| `scripts/docs/generate-public-changelog.mjs` | Good canonical CLI sync | Good enough |
| `scripts/docs/generate-llms.mjs` | Good machine-index generation | Good enough |
| `scripts/docs/check-model-references.mjs` | Useful model drift guard | Good enough |
| `scripts/generate-routekit-client-support.mjs` | Strong public/maintainer client sync | Good enough |
| `scripts/generate-routekit-l06-evidence.mjs` | Strong evidence rendering | Good enough |

## Benchmark observations

A lightweight comparison used mature developer-tool documentation patterns from
uv, Tailscale, LiteLLM, and Renovate. The comparison was limited to structure and
maintenance practices, never RouteKit product truth.

RouteKit already matches the strongest common pattern in its public portal:
separate getting-started, task guide, concept, and reference layers. Its compact
agent guide and machine-readable command/error artifacts are unusually strong.

The largest gap versus mature documentation systems is not page polish. It is
contract coherence at repository boundaries: security policy, support status,
package-level entry points, API stability, and versioned release history. Those
systems tend to make these boundaries explicit and centrally discoverable.

## Validation results

The final validation batch is recorded here after the audit report is drafted.

| Check | Result | Notes |
| --- | --- | --- |
| Repository-local skill validation | Passed | `quick_validate.py` reported `Skill is valid!`. |
| `pnpm check` | Passed | Registry, generated shell scripts, pricing, local catalog, Biome, syncpack, and dependency boundaries passed. |
| `pnpm docs:build` | Passed | Changelog, `llms.txt`, model references, MDX, TypeScript, and the 76-route Next.js production build passed. |
| `pnpm docs:generate-code` | Passed with warnings | TypeDoc generated output with 0 errors and 6 unresolved-link/not-included-symbol warnings, consistent with `DOC-M02`. |
| Repository-relative link check | Failed during analysis | Two broken links target the removed route-disclosure MDX file. |
| Public MDX route check | Passed during analysis | No current public page links to a missing `/docs/...` route. |
| Safe external-link sweep | Failed | The documented installer URL redirects to `@velum-labs/routekit-tracing@0.18.1/install.sh` and returns 404. Authenticated API/test-fixture responses were excluded from findings. |
| `git diff --check` | Passed | No whitespace errors. |

## Audit limitations

- No live website or rendered responsive/accessibility review was performed.
- The final safe-link sweep covered 88 extracted HTTPS strings, then discarded
  fixtures, templates, authenticated API endpoints, and endpoints where a base
  URL intentionally returns a non-document response. The installer failure was
  independently reproduced with its redirect chain and retained as `DOC-C00`.
- No product workflow was executed, so task-success scores rely on source and
  existing tests rather than fresh runtime evidence.
- TypeDoc output is gitignored. It generated successfully with six link warnings,
  but this report does not attempt a full symbol-by-symbol prose review of every
  generated page.
- Historical evidence was not requalified against current versions.

## Convergence and stopping condition

The repair stage should stop when:

1. `DOC-C01` and `DOC-C02` are closed and no automatic gate fails;
2. all Major defects are closed or explicitly accepted with an owner and reason;
3. the overall, surface, and priority-audience scores reach at least 75;
4. all configured validation commands pass;
5. remaining work consists only of Improvement opportunities or accepted Minor
   defects with no material task, safety, truth, or maintenance impact.

Do not rewrite the Good-enough pages as part of repair unless a selected finding's
acceptance criteria requires a localized change.
