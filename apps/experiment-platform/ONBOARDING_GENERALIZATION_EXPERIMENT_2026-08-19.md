# Held-out onboarding generalization experiment

## Question

Can Sol generate an eight-area repository registry from older coding work that Luna can
use accurately on genuinely later tasks?

This experiment corrects the task leakage in the first automated-onboarding pilot. No
held-out request is visible while the generated registries are constructed.

## Frozen design

Repositories:

- `backstage/backstage`;
- `grafana/grafana`;
- `kubernetes/kubernetes`.

For each repository:

1. Select 40 eligible older merged pull requests for registry construction.
2. Leave a minimum fourteen-day temporal embargo.
3. Select 40 newer merged pull requests for held-out evaluation.
4. Exclude bots, releases, dependency/version bumps, documentation-only changes,
   descriptions shorter than 100 characters, duplicate titles, and pull requests used
   in the earlier composition benchmark.
5. Retain changed-file paths for local audit only. Never place them in generation,
   reference, or Luna prompts.

The result is 120 construction tasks and 120 held-out evaluation tasks. Pull-request
title and cleaned body form the user-like request. Exact timestamps, commit SHAs, and
changed files remain audit metadata.

## Registries

Each repository has three eight-area candidates:

1. **Rule-guided Sol generation** — flat implementation responsibilities, bounded
   overlap, explicit exclusions, no aliases, catch-alls, or parent-child mixtures.
2. **Unconstrained Sol generation** — Sol chooses its own organizing principle.
3. **Existing human registry** — the previously frozen eight-area registry for that
   repository. Exact prior benchmark tasks are excluded from this held-out set.

Generated registries receive only the taxonomy-neutral repository profile and the 40
older requests.

## Reference and candidate

Construction has two immutable stages:

1. Sol creates one taxonomy-neutral responsibility decomposition for every held-out
   request.
2. For each registry, Sol maps that same frozen decomposition into area-composition
   scores and a separate unknown probability.

Luna directly classifies the held-out request against the same registry:

```json
{
  "area_composition_scores": {
    "area-a": 0.0,
    "area-b": 0.0
  },
  "unknown_probability": 0.0
}
```

Known-area scores are independent and do not need to sum to one.

## Metrics

Primary:

- active-area mean absolute error;
- active-area F1;
- cosine similarity;
- top-area agreement;
- unknown-probability mean absolute error.

Supporting:

- reference unknown probability, as a coverage signal;
- reference active-area count, as an overlap/fragmentation signal;
- per-repository metrics;
- task-paired bootstrap deltas between registries;
- structural checks for catch-alls, likely aliases, and parent-child pairs;
- valid-contract rate and provider cost.

The experiment does not test downstream model routing or the additivity of model
performance.

## Leakage safeguards

The frozen source and evaluation manifests assert:

- `strictTemporalSplit: true`;
- `temporalEmbargoDays: 14`;
- `generationEvaluationTaskOverlap: 0`;
- `heldoutTaskTextExcludedFromGeneration: true`;
- `changedFilesExcludedFromModelPrompts: true`;
- `neutralDecompositionFrozenBeforeRegistryMapping: true`;
- `lockedTestIncluded: false`.

## Vercel execution

The run uses the development experiment project, private Blob inputs, Vercel Workflow
and Queues, and hosted Luna/Sol calls through Vercel AI Gateway. Hosted concurrency
remains eight.

Stages:

1. 120 neutral Sol construction jobs.
2. Six registry-generation Sol jobs.
3. An 18-job evaluation canary: one task per repository, three registries, Sol and
   Luna.
4. The 720-job held-out evaluation.

No locked-test data is used.
