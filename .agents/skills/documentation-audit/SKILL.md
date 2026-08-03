---
name: documentation-audit
description: Audit a repository's documentation for factual accuracy, task success, coverage, information architecture, reference precision, audience fit, safety, usability, accessibility, machine consumption, and maintainability. Use when asked for a deep documentation audit, documentation release-readiness review, docs quality score, docs inventory, or a staged documentation audit and repair plan.
---

# Documentation Audit

Run evidence-based documentation audits that converge. Do not rewrite accurate
material merely because another phrasing is possible.

## Modes

Choose one at the start:

- `interactive`: ask only material scope questions, one at a time. Stop when the
  answers are sufficient to audit; do not exhaust a generic questionnaire.
- `defaults`: apply the defaults in this skill and record assumptions in the
  report.

Read `.documentation-audit.yaml` when present. Repository configuration overrides
the defaults here unless it weakens an explicit user requirement.

## Stages

Keep audit and repair separate.

### Audit

1. Lock scope, audiences, authorities, scoring, and deliverables.
2. Inventory every configured documentation surface.
3. Map material claims to sources of truth.
4. Review all surfaces before editing audited documentation.
5. Classify findings, score the corpus, and write the remediation plan.
6. Create the dated report from `assets/report-template.md`.
7. Run configured checks only after analysis and report drafting are complete.
8. Deliver the report and stop.

Do not repair audited documentation during this stage. Audit infrastructure such
as this skill, the repository configuration, and the audit report may be created.

### Repair

Start only after explicit approval of the completed audit.

1. Select approved findings and preserve their acceptance criteria.
2. Batch related changes instead of alternating between analysis and edits.
3. Avoid unrelated cleanup and optional rewrites.
4. Run targeted and broad checks after the repair batch is complete.
5. Record repaired, deferred, invalidated, and newly discovered findings.

## Evidence Rules

Use this default authority order:

1. Runtime implementation and schemas
2. Tests and generated artifacts
3. Specs explicitly labeled implemented
4. CLI help and error output
5. Documentation

Report disagreements between authorities even when the precedence resolves the
factual question. Treat proposed, planned, historical, and implemented documents
according to their declared status. Missing or ambiguous status is itself a
finding when readers could mistake intent for current behavior.

Historical evidence is immutable. Audit its date, revision, provenance, status
label, canonicality claims, and links; do not reinterpret it as current evidence.

For every defect, include:

- exact file and line references;
- a short excerpt when it makes the problem clearer;
- the governing source-of-truth references;
- the affected audience and user journey;
- user, security, operational, or maintenance impact;
- severity and evidence confidence;
- concrete remediation, dependencies, effort, acceptance criteria, and checks.

Confidence levels:

- `Verified`: reproduced by a deterministic check or generated output.
- `Strong`: directly established by implementation, schema, or canonical data.
- `Probable`: supported by multiple repository signals but not fully reproduced.
- `Subjective`: an editorial or UX judgment, clearly labeled.

## Default Rubric

Score each dimension from 0 to 4, then apply its weight.

| Dimension | Weight |
| --- | ---: |
| Factual integrity | 16 |
| Task success | 14 |
| Coverage and completeness | 10 |
| Information architecture | 9 |
| Reference precision | 9 |
| Audience fitness | 8 |
| Safety, security, and privacy | 8 |
| Operations and recovery | 7 |
| Cross-surface consistency | 5 |
| Clarity and usability | 5 |
| Web UX and accessibility | 4 |
| Machine consumption | 2 |
| Maintainability | 3 |

Score meanings:

- `4`: accurate, complete, verified, easy to use, and protected from drift.
- `3`: successful for most readers with localized gaps.
- `2`: material friction, omissions, ambiguity, or maintenance risk.
- `1`: frequently misleading, incomplete, or difficult to use.
- `0`: absent or unsafe.

Default readiness thresholds:

- `Ship`: 90–100
- `Ship with conditions`: 75–89
- `Do not ship`: below 75

An unresolved Critical defect, broken primary onboarding path, unsafe security
guidance, or materially false support or billing claim always means `Do not ship`.
Apply the same score and readiness labels to configured surfaces and audiences.

## Finding Classes

- `Defect`: violates the rubric, affects readiness, and requires repair.
- `Improvement opportunity`: provides concrete value but is not required for
  release readiness and does not lower the score.
- `Good enough`: accurate, clear for its audience, appropriately concise,
  consistent, and materially usable even if it could be phrased differently.

Severity applies only to defects:

- `Critical`: unsafe guidance, credential or data risk, destructive behavior,
  materially false billing/support claims, or a broken primary first-success path.
- `Major`: incorrect behavior or commands, failed important workflows,
  unsupported claims, or major audience and coverage gaps.
- `Moderate`: substantial friction, incomplete reference content,
  discoverability failures, or contradictions with practical workarounds.
- `Minor`: localized clarity, consistency, accessibility, or polish defects.

## Convergence Rules

Every proposed change must identify a concrete accuracy, task-success, safety,
consistency, accessibility, trust, discoverability, or maintenance benefit.

Do not create findings for:

- personal wording preferences;
- harmless stylistic variation;
- concise prose that already serves its audience;
- intentional repetition that supports separate entry points;
- unsupported-platform omissions when support status and alternatives are clear;
- optional comprehensiveness that would burden the primary journey;
- file age without evidence of behavioral drift.

Use Humanizer-style diagnostics only when a pattern reduces clarity, credibility,
precision, or naturalness. Watch for promotional language, vague attribution,
unsupported claims, canned transitions, forced groups of three, synonym cycling,
excessive dashes, repetitive conclusions, and conspicuous AI vocabulary. Preserve
necessary technical terms and established product language.

Stop proposing edits when release gates pass and remaining changes are optional
or marginal. Explicitly record representative surfaces that are already good
enough so the audit does not read as a mandate to rewrite everything.

## Review Procedure

### Inventory

For every configured document, record:

- surface and path;
- intended audience and purpose;
- lifecycle status;
- source of truth;
- generated or authored status;
- freshness evidence;
- audit status and associated findings.

### Analysis

Review:

- primary first-success and recovery journeys;
- commands, flags, output, errors, config, environment variables, defaults, and
  constraints;
- APIs, exports, examples, JSDoc, generated references, and package entry points;
- installation and explicit support status for claimed platforms;
- authentication, tokens, remote exposure, privacy, telemetry, billing, and
  destructive actions;
- navigation, progressive disclosure, terminology, internal linking, metadata,
  responsive and semantic source patterns, diagrams, and reduced motion;
- changelog history, release guidance, specs, contributor instructions, and
  documentation-related workflow or script comments;
- generated outputs, their inputs, and protections against drift;
- machine-readable documentation for discovery, context efficiency, attribution,
  and actionability;
- high-risk claims that lack automated contract coverage.

Repository-only audits may run static and build-time checks, but must not claim
runtime journey verification unless those workflows were actually executed.

External benchmarks may illustrate mature documentation practices. Explain why
each benchmark is relevant and never use it as a source of product truth.

### Reporting

Use `assets/report-template.md`. Organize defects by severity, then provide
indexes by surface and user journey. Include:

- overall, per-surface, and per-audience scores and readiness labels;
- automatic-gate results and a formal release verdict;
- an exhaustive defect catalog, consolidating repeated instances into systemic
  findings with complete affected-file lists;
- improvement opportunities separated from defects;
- a complete document inventory, including documents with no findings;
- file-level remediation with `XS`, `S`, `M`, `L`, or `XL` effort;
- validation commands and limitations;
- good-enough examples and an explicit stopping condition.

Effort definitions:

- `XS`: one localized edit.
- `S`: one small, contained document update.
- `M`: several related pages or one structural change.
- `L`: a cross-surface rewrite or new documentation system.
- `XL`: a broad information-architecture or product-supported overhaul.

Name reports consistently as `documentation-audit-YYYY-MM-DD.md` in the
configured report directory.

