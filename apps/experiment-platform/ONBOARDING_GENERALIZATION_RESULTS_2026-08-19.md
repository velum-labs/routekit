# Held-out onboarding generalization results — 2026-08-19

## Executive result

The leakage-free held-out experiment completed successfully on the Vercel experiment
platform:

- 720/720 evaluation jobs succeeded.
- 720/720 responses produced a valid composition contract.
- The benchmark contained 120 later coding tasks across Backstage, Grafana, and
  Kubernetes.
- Each generated registry saw only 40 older tasks from its repository, followed by a
  minimum fourteen-day temporal embargo.
- Held-out request text, changed files, and final implementation details were not
  available during registry generation.
- Evaluation cost was $14.7784. Successful construction cost another $4.9794.
- The evaluation dataset hash was
  `263d64207fb0c12fdde120d528584beed2d565a5f25e1a9d336b1372a8f22259`.
- No locked-test data was used.

The unconstrained Sol-generated registry was the strongest balanced candidate. It had
the lowest active-area error, highest cosine similarity, highest top-area agreement,
lowest unknown error, and much better coverage than the rule-guided registry. The
existing human registry retained the best active-area F1.

This is useful evidence that automated onboarding can generate a viable area-registry
draft. It is not evidence that one generation prompt is universally best: aggregate
paired differences were not conclusive, and the winner varied substantially by
repository.

## Question and design

The experiment asked:

> Can Sol generate an eight-area repository registry from older coding work that Luna
> can use accurately on genuinely later tasks?

For each repository:

1. Forty older merged pull requests were selected for registry construction.
2. A minimum fourteen-day embargo separated construction from evaluation.
3. Forty newer merged pull requests were reserved for held-out evaluation.
4. Bots, releases, dependency bumps, documentation-only changes, short descriptions,
   duplicate titles, and tasks used in the prior benchmark were excluded.
5. Changed-file paths were retained for local auditing but never supplied to registry
   generation, reference construction, or Luna.

Three eight-area registries were compared:

1. **Rule-guided generated** — Sol was instructed to produce flat implementation
   responsibilities with bounded overlap, explicit exclusions, and no catch-alls,
   aliases, or parent-child mixtures.
2. **Unconstrained generated** — Sol chose its own organizing principle.
3. **Human** — the existing human-designed registry from the earlier benchmark.

For every held-out task, Sol first created one frozen, taxonomy-neutral responsibility
decomposition. Sol then mapped that same decomposition into each registry. Luna
directly classified the task against each registry using:

```json
{
  "area_composition_scores": {
    "area-a": 0.0,
    "area-b": 0.0
  },
  "unknown_probability": 0.0
}
```

Known-area scores were independent and did not need to sum to one.

## Aggregate results

| Registry | Active MAE ↓ | Cosine ↑ | Active F1 ↑ | Top area ↑ | Unknown MAE ↓ | Reference unknown |
| -- | --: | --: | --: | --: | --: | --: |
| Unconstrained generated | **0.0976** | **0.9076** | 0.8264 | **94.2%** | **0.1161** | **0.2086** |
| Rule-guided generated | 0.1194 | 0.8832 | 0.7589 | 88.0% | 0.1749 | 0.4068 |
| Human | 0.1339 | 0.8998 | **0.8417** | 90.9% | 0.1444 | 0.3639 |

Interpretation:

- **Unconstrained generation had the best overall balance.** It most closely matched
  Sol's score magnitudes and dominant area while covering more of the held-out work.
- **The human registry found the correct active-area set slightly more reliably.** Its
  active F1 of 0.8417 was better than 0.8264 for unconstrained generation.
- **The rule-guided prompt did not generalize as well as expected.** Its coverage and
  classification metrics were both weaker than the unconstrained draft in aggregate.
- **Luna's output was operationally reliable.** Every call returned a valid contract.

The paired active-MAE differences were:

| Comparison | Mean difference | 95% interval |
| -- | --: | --: |
| Unconstrained generated minus human | -0.0256 | [-0.0543, 0.0054] |
| Rule-guided generated minus human | -0.0119 | [-0.0427, 0.0201] |
| Rule-guided minus unconstrained generated | 0.0137 | [-0.0143, 0.0403] |

Negative values favor the first registry. All three aggregate intervals include zero,
so this benchmark does not establish a conclusive universal winner.

## The coverage caveat

Active-area MAE measures Luna's error on areas that Sol considered active. It does not
by itself measure whether the registry represents enough of the repository.

A narrow registry can look easy to classify because Sol maps much of the work to
`unknown_probability` rather than activating a known area. The classifier then has
fewer active known areas on which it can make a mistake.

Two results show why coverage must be considered alongside classification accuracy:

- The Backstage human registry achieved an excellent active MAE of 0.0318, but its
  reference unknown probability was 0.6002. It classified its represented work very
  well while leaving much of the held-out workload outside the registry.
- The Kubernetes rule-guided registry achieved an active MAE of 0.0850, but its
  reference unknown probability was 0.7056. This is not a useful practical win because
  approximately 71% of task mass was judged outside the registry.

The unconstrained generated registry had the best aggregate coverage/classifiability
trade-off: reference unknown probability was 0.2086 while active MAE remained 0.0976.

## Repository-specific results

### Backstage

| Registry | Active MAE ↓ | Active F1 ↑ | Top area ↑ | Unknown MAE ↓ | Reference unknown |
| -- | --: | --: | --: | --: | --: |
| Unconstrained generated | 0.0781 | 0.8632 | 94.4% | 0.1105 | 0.1438 |
| Rule-guided generated | 0.1397 | 0.8070 | 82.5% | **0.0899** | **0.1394** |
| Human | **0.0318** | **0.9362** | **100.0%** | 0.1643 | 0.6002 |

The human registry was easiest for Luna to classify when a known area was applicable,
but it had very poor coverage. Both generated registries covered much more of the
work. The unconstrained generated registry was the better practical generated draft.

### Grafana

| Registry | Active MAE ↓ | Active F1 ↑ | Top area ↑ | Unknown MAE ↓ | Reference unknown |
| -- | --: | --: | --: | --: | --: |
| Unconstrained generated | 0.1168 | **0.8367** | **97.4%** | **0.0700** | **0.1058** |
| Rule-guided generated | **0.1019** | 0.7356 | 96.6% | 0.1935 | 0.3752 |
| Human | 0.1710 | 0.8000 | 82.9% | 0.0975 | 0.2043 |

Generated registries outperformed the human registry on most classifier metrics. The
unconstrained registry had the stronger balance of coverage, active F1, top-area
agreement, and unknown accuracy.

### Kubernetes

| Registry | Active MAE ↓ | Active F1 ↑ | Top area ↑ | Unknown MAE ↓ | Reference unknown |
| -- | --: | --: | --: | --: | --: |
| Unconstrained generated | 0.0968 | 0.7789 | 89.7% | **0.1679** | 0.3761 |
| Rule-guided generated | **0.0850** | 0.6923 | 85.7% | 0.2411 | 0.7056 |
| Human | 0.1500 | **0.8409** | **93.5%** | 0.1714 | **0.2873** |

Generated registries lowered active-area error, but the rule-guided registry omitted
too much of the repository to be useful. The human registry retained the best
active-area set and top-area behavior. No candidate dominated: the unconstrained
registry improved score accuracy, while the human registry offered better coverage
and area-set precision.

## Structural diagnostics

The static registry audit detected no:

- catch-all areas;
- likely alias pairs;
- parent-child conflicts at the same runtime level.

These constraints are still sensible minimum validation gates. Their absence did not
guarantee good coverage or classification, so onboarding must also evaluate the draft
against representative held-out tasks.

## Product recommendation

Do not automatically accept the first registry produced by one prompt.

For the first onboarding product:

1. Generate at least two eight-area drafts:
   - one unconstrained draft;
   - one constrained draft using the flat-area rules.
2. Evaluate both on a small set of newer or otherwise held-out repository tasks.
3. Measure both axes:
   - **coverage:** reference unknown probability;
   - **classifiability:** active MAE, active F1, top-area agreement, and unknown MAE.
4. Reject aliases, catch-alls, and parent-child conflicts before scoring.
5. Present the coverage/classifiability trade-off to the user instead of choosing from
   classifier accuracy alone.
6. Ask a human to review missing responsibilities, confusing boundaries, and whether
   the areas are useful for model routing.
7. Keep `unknown_probability` separate from known-area composition scores at runtime.

The recommended selection rule is a small Pareto frontier: retain drafts for which no
other draft is simultaneously better on both coverage and classifiability, then let a
human choose the most useful routing representation.

## What this experiment does not establish

- It does not prove that unconstrained generation will win on every repository.
- It does not measure whether the chosen areas maximize downstream model-routing
  quality.
- It does not validate purely additive model performance across areas.
- It does not replace expert review of repository coverage.
- It uses merged pull-request descriptions as realistic coding tasks, not private
  conversational Codex sessions.
- It covers three large open-source repositories and should be repeated on customer
  repositories before fully automatic onboarding.

## Cost and latency

| Stage | Cost |
| -- | --: |
| Successful construction | $4.9794 |
| Evaluation canary | $0.3453 |
| Full held-out evaluation | $14.7784 |
| Failed first registry-construction attempt | $1.2581 |
| Total new experiment spend | approximately $21.36 |

Including the prior onboarding experiments, cumulative experiment spend was
approximately $99.18, below the $200 ceiling.

The Luna portion of the full evaluation cost approximately $0.5621 for 360 calls, or
$0.00156 per classification. Median Luna latency was approximately 4.9–5.1 seconds,
depending on the registry.

## Execution notes

The old free Neon database exceeded its transfer quota during preparation. The
development platform was moved to the new `routekit-experiments-development-2`
resource on the Neon Launch plan and redeployed. Postgres, private Blob storage, and
AI Gateway preflight checks passed afterward.

One final queued job stalled and was safely redispatched through Vercel Queue with a
new message idempotency key. Automatic reconciliation for abnormally long queued jobs
should be added before relying on unattended large runs.

## Reproducibility

Experiment IDs:

```text
onboarding-generalization-neutral-120-v1
onboarding-generalization-neutral-retry-1-v1
onboarding-generalization-registries-3-v2
onboarding-generalization-heldout-canary-3-v1
onboarding-generalization-heldout-120-v1
```

The frozen design is documented in
`apps/experiment-platform/ONBOARDING_GENERALIZATION_EXPERIMENT_2026-08-19.md`.
Frozen manifests are in
`apps/experiment-platform/examples/onboarding-generalization/`. Aggregated local
artifacts are in the gitignored
`.routekit-experiment-assets/onboarding-generalization-20260819/results/` directory,
and immutable run inputs and outputs remain in private Vercel Blob storage.
