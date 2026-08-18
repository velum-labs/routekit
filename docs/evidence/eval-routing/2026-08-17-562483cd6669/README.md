# Compositional eval-routing live qualification — 2026-08-17

Result: **Pass**

This directory is the sanitized, committed evidence from the first complete
eight-area billed compositional-routing qualification.

## Run identity

- Run ID: `20260817T191548324Z-562483cd6669`
- Tested revision: `562483cd66693d44576c343c3daa5288cbe1a8cc`
- Objective: `highest-quality`
- Classifier: `openai/gpt-5.6-luna`
- Suite author and judge: `openai/gpt-5.6-terra`
- Candidates:
  - `openai/gpt-5.6-luna`
  - `openai/gpt-5.6-terra`
  - `openai/gpt-5.6-sol`

## Result

- Eight routing areas
- Five authored cases per area
- Three candidates per area
- Thirty candidate-plus-judge calls per area
- Twenty-six classifier qualification cases
- Twelve successful `model: auto` probes
- 298 guarded billed calls
- 179,823 input tokens
- 64,430 output tokens
- 298 unpriced calls
- Zero active reservations
- Zero unknown measurements
- Final status: `passed`

GPT-5.6 pricing was unavailable. The report therefore treats
`estimatedCostUsd` as only the known-priced subtotal and reports the total
estimate as unknown. The dollar failsafe was unavailable for these unpriced
calls; call, token, per-call output, and wall-time failsafes remained active.

## Contents

- `report.json`: final post-cleanup report and the twelve routing decisions.
- `events.jsonl`: sanitized lifecycle and accounting journal.
- `classifier-qualification-v2.json`: reviewed classifier benchmark results.
- `published-routing.v2.json`: published eight-area model evidence matrix.
- `areas/<area>/eval/`: exact authored suite used by the live comparison.
- `areas/<area>/comparison.json`: sanitized per-model, per-case measurements.
- `areas/<area>/routing-profile.yaml`: generated routing profile.
- `SHA256SUMS`: hashes of the retained machine-readable artifacts.

Each eval directory is self-contained and includes its authoritative
`routekit.eval-manifest.json`, generated `*.eval.ts`, and `data/cases.json`.

## Sanitization boundary

The committed evidence contains generated eval definitions, case material,
case IDs, model IDs, normalized classifier vectors, call IDs, token counts,
timings, judge scores, outcome labels, digests, and cleanup/accounting state.

It does not contain provider credentials, authorization headers, provider
responses, raw child-process output, account identifiers, or temporary
worktree paths.

Five cases per area qualify this testdrive only. Production activation remains
gated on at least twenty reviewed model-eval cases per area and a corresponding
complete evidence matrix.
