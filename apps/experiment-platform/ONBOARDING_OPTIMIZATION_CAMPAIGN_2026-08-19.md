# Onboarding optimization campaign — 2026-08-19

## Objective

Turn automated repository onboarding into a repeatable generate, validate, select, and
repair process rather than relying on one area-registry generation prompt.

This campaign follows the held-out generalization result in
`ONBOARDING_GENERALIZATION_RESULTS_2026-08-19.md`. It keeps the runtime classifier
fixed:

- direct Luna classification;
- task-aware context;
- independent area-composition scores;
- separate `unknown_probability`;
- complete semantic Area Cards;
- no runtime tools or retrieval.

The campaign changes only the reference audit, onboarding inputs, candidate registry,
registry-selection procedure, amount of history, and evaluation cohort.

## Budget and execution limits

- Development Vercel project only.
- No locked-test data.
- Existing cumulative experiment spend: approximately $99.18.
- Campaign provider-cost ceiling: $90.
- Existing total ceiling after this campaign: $200.
- Maximum hosted concurrency: eight.
- Every paid stage requires a canary or reuses a previously proven model route.
- Sol neutral decompositions are computed once and reused across registries.
- Later stages run only after their input-producing stage has completed successfully.

## Experiment 1: independent-reference audit

Question: does Sol favor registries expressed in Sol-like language?

On a stratified final-test subset, Claude Sonnet 5 independently maps the same frozen
taxonomy-neutral decomposition into each candidate registry. Its composition vectors
are compared with Sol's vectors and Luna's predictions.

Primary outputs:

- Sol-versus-Claude active-area MAE, cosine similarity, active F1, top-area agreement,
  and unknown MAE;
- registry ranking under each judge;
- judge-by-registry interaction;
- disagreement examples.

The available data contains no genuine human-authored composition labels. The
campaign therefore creates a blinded human-review packet but does not call model
labels human labels.

## Experiment 2: registry-generation information

For Backstage, Grafana, and Kubernetes, compare registries generated from:

1. forty recent historical tasks only;
2. the pre-evaluation repository structure only;
3. structure plus forty recent tasks;
4. structure, tasks, and older changed-path statistics;
5. the same hybrid input with a stricter flat-area prompt.

Repository structure includes only information available at the historical snapshot:
directory and extension counts, manifests, CODEOWNERS when present, and short
architecture/README excerpts. Held-out requests and later repository state remain
excluded.

## Experiment 3: candidate portfolio, selection, and repair

Use a nested chronological split:

1. historical construction tasks;
2. the oldest twelve tasks from the prior held-out set as validation;
3. the newest twenty-eight tasks as untouched final test.

Generate a portfolio, evaluate every candidate on validation, reject structurally
invalid candidates, and select one candidate per repository with a frozen
coverage/classifiability objective. Sol receives only validation errors for one repair
pass. The selected original and repaired registry are then evaluated on final test
against the previous unconstrained generated registry and the existing human
registry.

The selection objective is fixed before results:

```text
active MAE
+ 0.50 × unknown MAE
+ 0.15 × reference mean unknown probability
+ structural penalties
```

Structural penalties reject catch-alls, likely aliases, and parent-child mixtures at
the same runtime level. Selection also reports the full Pareto frontier so the scalar
score cannot hide coverage/classifiability trade-offs.

## Experiment 4: historical-data curve and sampling

Generate hybrid registries using 5, 10, 20, 40, and 80 older tasks. Compare recent
sampling with deterministic diversity-aware sampling. Also compare six, eight, and
ten areas.

Primary outputs:

- validation and final-test learning curves;
- generation variance for two forty-task drafts;
- minimum history that reaches 95% of the best validation performance;
- repository-specific preferred area count.

## Experiment 5: natural unknown and multi-area challenge set

Evaluate the selected and repaired registries on the existing 48-task natural-hard
cohort for Grafana and Kubernetes. The cohort was selected before this campaign and
contains requests without exact paths or area names, multi-area cases, open-set work,
and requests requiring repository interpretation.

Primary outputs:

- unknown MAE, Brier score, and threshold curves;
- false-unknown and missed-unknown rates;
- multi-area recall and all-active-at-three;
- calibration by repository and difficulty.

## Experiment 6: real conversational prompts

Use the frozen 45-task real conversational coding cohort collected from individual
Codex accounts across RouteKit, Factory, Ori, and Velum. Registry construction uses
separate reference-split episodes plus repository structure; task IDs in the
evaluation cohort are excluded from construction.

Primary outputs:

- composition agreement on short and referential prompts;
- performance by context type;
- open-set rate;
- comparison between public pull-request and real-conversation performance.

This is a development cohort, not a locked test, and is smaller and less
repository-balanced than the eventual 300–500 prompt launch benchmark.

## Experiment 7: human-assisted onboarding proxy and review packet

For RouteKit, compare:

1. the existing human-designed registry;
2. the automatically generated registry;
3. an automatically repaired registry using validation errors.

The campaign measures classification and coverage, and produces a blinded review
packet containing registry cards, structural warnings, validation examples, and
missing-responsibility summaries.

Actual review time, edit count, and engineer satisfaction require human participants
and cannot be truthfully synthesized by an unattended model run. Those fields remain
explicitly unmeasured until engineers complete the packet.

## Shared safeguards

- No task used for registry construction is used for final evaluation.
- Candidate selection and repair never see final-test task text.
- Changed paths from validation or final-test pull requests never enter model prompts.
- Historical changed-path statistics use construction tasks only.
- Repository structure is read from the construction-era Git snapshot.
- The neutral responsibility decomposition is frozen before registry mapping.
- Registry source is hidden from independent judges.
- All task inputs, manifests, model IDs, hashes, and outputs remain immutable.
- Private conversational prompts remain in private Blob storage and are never
  committed.

## Stop conditions

Stop a stage before the full run if:

- a canary produces an invalid contract;
- any leakage assertion fails;
- the projected cumulative provider budget exceeds $90;
- a required repository snapshot cannot be resolved;
- more than 2% of a stage's contracts are invalid;
- the Vercel project role is not `development`.
