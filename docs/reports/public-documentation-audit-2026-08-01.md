# Public documentation audit — 2026-08-01

## Executive diagnosis

The public portal had strong architecture, machine-readable output, and unusual
contract testing, but several primary-journey claims had drifted from RouteKit
0.17.4. The audit found a non-runnable subscription-first quickstart, an invalid
remote-install positional argument, incorrect Cursor launch language, omitted
native-install behavior, and qualification summaries that no longer matched
the canonical durable evidence file.

This pass updates the public content, aligns maintainer mirrors where required,
and adds contract tests for each high-risk failure. No route was promoted beyond
the evidence available in the repository.

Baseline:

- Documentation portal: `66b006e` (2026-07-29)
- Audited product revision: `f74b6886e438a309a2caac281ababe8c47d6977b`
- Audited CLI version: `0.17.4`
- Qualification evidence baseline: RouteKit `0.8.0`, revision
  `be81fa847d74c64fa8720c9ecf1d0c6abebd58fa`, 2026-07-22

## Strategic score

This is an implementation-audit estimate, not a formal blind evaluation.

| Dimension | Before | After |
| --- | ---: | ---: |
| Factual integrity | 1/4 | 4/4 |
| Positioning and message clarity | 3/4 | 3/4 |
| Information architecture | 2/4 | 3/4 |
| Page portfolio and surface fit | 2/4 | 3/4 |
| Product proof | 3/4 | 3/4 |
| Conversion and continuation | 2/4 | 3/4 |
| Cross-page narrative | 2/4 | 3/4 |
| Documentation usability | 2/4 | 3/4 |
| Actionability and readiness | 2/4 | 4/4 |
| **Normalized** | **53/100** | **81/100** |

## Resolved findings

### Critical — qualification summaries drifted from durable evidence

**Observation:** The public routes-and-billing page linked an older immutable
real-account revision and called several route cases pass or fail. The current
canonical `docs/routekit-l06-evidence.json` binds a different revision and marks
all seven launch routes pending.

**Interpretation:** The page identifies itself as authoritative, so status drift
can lead users to infer qualification that the current evidence system does not
grant.

**Remediation:** The public page now uses the canonical version, revision, date,
and pending statuses. It distinguishes deterministic observations from live or
manual qualification and retains the older report only as historical evidence.
Tests compare every public route section with the durable evidence metadata.

### Major — subscription-first quickstarts were not routable

**Observation:** `config init` enables OpenAI by default. The public installation
and subscription examples proceeded to daemon-backed subscription enrollment
without setting `OPENAI_API_KEY`, even though a configured provider must be
usable before the daemon can start.

**Interpretation:** A new subscription-only user could fail before reaching
OAuth, with no explanation of the dependency.

**Remediation:** Installation now provides one verified API-key first success,
expected output, and recovery. Subscription guides establish a working daemon
before enrollment and state the current bootstrap limitation explicitly.

### Major — Cursor was described as a launched client

**Observation:** Landing and guide copy grouped Cursor with spawned Codex and
Claude launchers. The implementation prints Cursor BYOK settings and exits.

**Interpretation:** Users could wait for an editor process that RouteKit never
starts or assume `cursor-agent` traffic uses the RouteKit gateway.

**Remediation:** All public entry points now describe Codex/Claude launch versus
Cursor custom-endpoint configuration. Contract tests reject the old claim.

### Major — concise command reference contained invalid and missing behavior

**Observation:** It documented `routekit remote install <name>` although the
positional argument is `<ssh-host>`, and it omitted several public command groups
and recent native-install flags.

**Interpretation:** The lookup surface could produce an immediately failing
command and did not cover the CLI it claimed to reference.

**Remediation:** The page now covers every public top-level command, exact remote
syntax, global targeting, native integration lifecycle, `--no-token`, inspection,
advanced daemon operations, and maintenance. Tests enforce top-level coverage and
the corrected syntax.

### Moderate — configuration reference did not describe the strict schema

**Observation:** The public reference documented model policy but omitted most
provider policy, aliases, reasoning overrides, leaderboard bounds, credential
rejection, and CLI-versus-SDK semantics.

**Interpretation:** Operators had to extract valid fields and limits from a
723-line user guide or source code.

**Remediation:** The reference now documents every top-level schema field,
ranges, defaults, validation behavior, credential boundaries, and the layered
SDK distinction.

### Moderate — public changelog did not explain releases

**Observation:** The changelog only linked to a package file and carried one
support-contract note.

**Interpretation:** Users could not determine what 0.17 changed or whether an
action was required.

**Remediation:** The public page is now generated from the canonical CLI
changelog, and docs validation fails when the committed page is stale. Contract
tests require the generated marker and current CLI version to appear.

### Moderate — generated TypeDoc was presented as part of the site

**Observation:** Root docs commands generated TypeDoc before every docs preview,
but Fumadocs loads only `content/docs`; generated symbol pages were never routed.

**Interpretation:** Contributors paid the generation cost and could reasonably
expect symbol pages to appear publicly.

**Remediation:** TypeDoc is now an explicit local-only command. Public API and
package pages state that the generated Markdown is not published. Docs preview
and build no longer generate unused TypeDoc output.

### Minor — sidebar shortcuts duplicated the document tree

**Observation:** Global Guide and Commands shortcuts appeared above the same
destinations in the Fumadocs page tree, while separator labels duplicated folder
titles.

**Interpretation:** The hierarchy looked like separate content systems.

**Remediation:** Redundant global shortcuts and duplicate section separators are
removed; folder dropdowns remain the navigation source.

## Strengths preserved

- Registry-backed model examples and current package version components
- Per-page Markdown, `llms.txt`, and `llms-full.txt`
- Search, source/edit actions, selected-text feedback, and Open Graph images
- Explicit billing, egress, quota, credential-owner, and unlimited-use fields
- Extensive documentation-contract tests and immutable evidence anchors
- Existing RouteKit visual identity, responsive shell, and Mermaid mental model

## Remaining evidence limitations

- All public launch routes remain Planned Supported while the canonical L06
  report is pending. New live/manual evidence is required before labels change.
- RouteKit cannot currently bootstrap its first subscription account from an
  otherwise unroutable canonical configuration; documentation now exposes that
  constraint rather than hiding it.
- Generated TypeScript symbol documentation remains local-only.
- Hosting and deployment configuration for the public Next.js site is external
  to this repository.

The ongoing process is documented in
[`docs/public-documentation-maintenance.md`](../public-documentation-maintenance.md).
