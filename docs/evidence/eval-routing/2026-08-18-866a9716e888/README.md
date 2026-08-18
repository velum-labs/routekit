# Compositional eval-routing live qualification — 2026-08-18

Result: **Pass**

This directory retains the sanitized evidence from the billed eight-dimension
compositional-routing qualification of revision
`866a9716e8889964de9f765e5c0fb4490cd7f670`.

## Run identity

- Run ID: `20260818T115435989Z-866a9716e888`
- Started: `2026-08-18T11:54:35.989Z`
- Finished: `2026-08-18T12:14:05.859Z`
- Objective: `highest-quality`
- Classifier: `openai/gpt-5.6-luna`
- Suite author and judge: `openai/gpt-5.6-terra`
- Candidates:
  - `openai/gpt-5.6-luna`
  - `openai/gpt-5.6-terra`
  - `openai/gpt-5.6-sol`

## Result

- Eight routing dimensions
- Five authored cases per dimension
- Three candidates per dimension
- Thirty candidate-plus-judge calls per dimension
- Twenty-six passing classifier qualification cases
- Twelve successful `model: auto` probes
- 298 guarded billed calls
- 183,483 input tokens
- 70,547 output tokens
- 298 unpriced calls
- Zero active reservations
- Zero unknown measurements
- 634 final events
- Final status: `passed`

GPT-5.6 pricing was unavailable. `estimatedCostUsd` is therefore only the
known-priced subtotal and the total estimate is unknown. The dollar failsafe
was unavailable for unpriced calls; call, input-token, output-token, per-call
output, and wall-time failsafes remained active.

## Contents

- `report.json`: final post-cleanup report and twelve routing decisions.
- `events.jsonl`: sanitized lifecycle and accounting events.
- `decomposition-qualification.json`: classifier benchmark results.
- `published-routing.json`: published eight-dimension evidence matrix.
- `dimensions/<dimension>/eval/`: exact authored suite used by the comparison.
- `dimensions/<dimension>/comparison.json`: sanitized per-model measurements.
- `SHA256SUMS`: hashes of the retained machine-readable artifacts.

Each eval directory contains its authoritative manifest, generated `*.eval.ts`
file, and exact `data/cases.json`.

## Sanitization boundary

The retained evidence includes reviewed eval case material, model IDs,
normalized decomposition vectors, call IDs, token counts, timings, judge
scores, outcome labels, digests, and cleanup/accounting state.

It does not contain provider credentials, authorization headers, provider
responses, raw child-process output, account identifiers, or temporary
worktree paths.

Five cases per dimension qualify this testdrive only. Production activation
still requires at least twenty reviewed model-eval cases per dimension and a
complete corresponding evidence matrix.
