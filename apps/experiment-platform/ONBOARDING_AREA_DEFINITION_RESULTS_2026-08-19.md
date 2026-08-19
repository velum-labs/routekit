# Onboarding area-definition experiments — 2026-08-19

## Executive result

All five development experiments completed on the Vercel experiment platform:

- 3,608/3,608 hosted-model jobs succeeded.
- 3,607/3,608 responses produced a valid composition contract.
- Evaluation provider cost was $73.2903.
- Luna accounted for $3.8272 across 2,154 classifications, or about $0.00178 per call.
- The two construction runs cost another $4.5319, for $77.8221 before negligible canaries.
- No locked-test data was used.

The strongest practical onboarding policy supported by these runs is:

1. Generate a flat registry of approximately eight implementation-responsibility areas.
2. Allow bounded co-activation; do not require areas to be mutually exclusive.
3. Do not mix parents and children at the same runtime level.
4. Avoid vague `other` areas. Preserve `unknown_probability` as a separate output.
5. Give every area a semantic definition, inclusions, exclusions, confusing neighbors,
   and boundary rules.
6. Add a small amount of representative repository evidence, but never use snippets
   without the semantic card.
7. Treat automated generation as a draft for human review. Its apparent win in the
   pilot is not yet a generalization result because generation and evaluation reused
   many of the same development tasks.

## Evaluation contract

Luna classified task-aware coding requests into:

```json
{
  "area_composition_scores": {
    "area-a": 0.0,
    "area-b": 0.0
  },
  "unknown_probability": 0.0
}
```

Known-area scores were independent and did not need to sum to one. Sol first produced
a frozen taxonomy-neutral responsibility decomposition. For each candidate registry,
Sol mapped that same decomposition into the supplied areas. Luna's direct
classification was then compared with that reference.

Primary interpretation:

- lower active-area MAE is better;
- higher cosine similarity and active-area F1 are better;
- higher top-area agreement is better;
- lower unknown MAE is better;
- reference unknown probability estimates registry coverage;
- reference active-area count estimates fragmentation or overlap.

No single metric defines a useful taxonomy. A broad catch-all can reduce unknown
probability while destroying out-of-distribution detection, and a four-area taxonomy
can be easy to classify while providing too little routing resolution.

## Experiment 1: common-reference taxonomy comparison

Dataset: 60 Backstage development tasks.

| Registry | Active MAE | Cosine | Active F1 | Top-area agreement | Reference unknown | Reference active areas |
| -- | --: | --: | --: | --: | --: | --: |
| Coarse four | 0.1485 | 0.8288 | 0.9524 | 95.8% | 0.2957 | 1.02 |
| Official flat eight | 0.1840 | 0.9411 | 0.9385 | 95.8% | 0.3257 | 1.05 |
| Parent plus child, nine | 0.1945 | 0.9049 | 0.9231 | 91.7% | 0.3252 | 1.15 |
| Redundant alias, nine | 0.1800 | 0.9105 | 0.9167 | 93.8% | 0.3103 | 1.12 |
| Domain plus layer factors, thirteen | 0.2063 | 0.9517 | 0.8750 | 86.7% | 0.1228 | 3.03 |

Interpretation:

- Four coarse areas were easiest to classify, but this does not prove they contain
  enough model-routing information.
- The flat eight-area registry retained much more semantic resolution while remaining
  highly classifiable.
- Adding a parent next to its child or a duplicate alias reduced classification
  quality.
- Mixing domain areas with horizontal layers reduced unknown mass, but produced about
  three active areas per task and captured all active areas in the top three only 55%
  of the time. This is a different, much more entangled representation.

## Experiment 2: unknown handling

Dataset: 42 synthetic composite tasks plus 18 real tasks.

| Treatment | Reference unknown | Unknown MAE | Soft Brier | Agreement at 0.5 | Active F1 |
| -- | --: | --: | --: | --: | --: |
| Separate unknown output | 0.5548 | 0.1738 | 0.0810 | 85.0% | 0.8197 |
| Vague `other` area | 0.0240 | 0.1233 | 0.0894 | 90.0% | 0.8517 |
| Positively defined shared area | 0.3717 | 0.1282 | 0.0520 | 88.3% | 0.8176 |

The vague `other` area is not a real improvement. It absorbed almost all unrepresented
work and reduced the reference unknown probability from 0.55 to 0.02. Its high
threshold agreement was largely trivial because both models almost never emitted a
large unknown value.

The separate unknown contract preserved the intended out-of-distribution signal. Luna
matched Sol's 0.5 decision on 85% of tasks. A positively defined shared area can be
valid when it represents a real, benchmarkable responsibility, but it changes what is
considered in-distribution and should not be used as a disguised catch-all.

## Experiment 3: granularity and overlap

Dataset: all 100 development tasks across Backstage, Grafana, and Kubernetes.

| Registry | Active MAE | Cosine | Active F1 | Top-area agreement | All active at 3 | Reference active areas |
| -- | --: | --: | --: | --: | --: | --: |
| Coarse four | 0.1715 | 0.8299 | 0.8378 | 89.6% | 100.0% | 0.98 |
| Controlled flat eight | 0.1734 | 0.8696 | 0.8087 | 88.0% | 98.7% | 0.94 |
| Forced-disjoint eight | 0.1734 | 0.8423 | 0.7707 | 88.0% | 97.3% | 0.83 |
| Leaf-only twelve | 0.2415 | 0.8193 | 0.7433 | 75.3% | 84.9% | 1.08 |
| Leaf-only sixteen | 0.3037 | 0.7672 | 0.7019 | 64.0% | 72.0% | 1.36 |
| Parent-child twelve | 0.2159 | 0.8646 | 0.8307 | 84.0% | 89.3% | 1.38 |
| Parent-child sixteen | 0.2256 | 0.8665 | 0.8367 | 81.3% | 68.0% | 1.78 |

Conclusions:

- Four and eight areas were effectively tied on active-area MAE. Eight is the better
  product default because it preserves more routing resolution.
- Bounded overlap was helpful. Forcing exactly one owner reduced active F1 from 0.809
  to 0.771 relative to the controlled eight-area registry.
- Moving from eight to twelve or sixteen leaf areas caused a large and consistent
  classification degradation.
- Parent-child mixtures were less damaging than arbitrary leaf splitting but created
  more simultaneous activations and weaker top-area behavior.
- The Kubernetes segment remained substantially harder than Backstage or Grafana,
  so onboarding validation must include repository-specific checks rather than rely
  only on aggregate metrics.

One of 100 Luna calls in the twelve-leaf arm spent all 8,192 completion tokens on
reasoning and returned no JSON. This produced the only invalid contract in the 3,608
evaluation calls. A production implementation should retry this rare failure with a
larger output allowance or a lower-reasoning fallback.

## Experiment 4: minimum useful Area Card

Dataset: all 100 development tasks, with the area semantics fixed.

| Card treatment | Active MAE | Cosine | Active F1 | Top-area agreement | Unknown MAE | Luna cost |
| -- | --: | --: | --: | --: | --: | --: |
| Complete card | 0.1888 | 0.8816 | 0.7848 | 90.7% | 0.1388 | $0.1782 |
| Complete card plus snippets | 0.1854 | 0.8942 | 0.8051 | 93.3% | 0.1124 | $0.2001 |
| Summaries | 0.1856 | 0.8971 | 0.7252 | 89.3% | 0.1249 | $0.1025 |
| Three anchors | 0.1871 | 0.8887 | 0.7300 | 89.3% | 0.1194 | $0.0974 |
| Positive and negative examples | 0.1974 | 0.8836 | 0.7949 | 90.7% | 0.1405 | $0.1599 |
| Snippets without full semantics | 0.1792 | 0.8517 | 0.7203 | 89.3% | 0.1293 | $0.1178 |

Complete cards plus representative snippets had the best balanced result: highest
active F1, highest top-area agreement, and lowest unknown MAE. The improvement over a
complete card was modest and varied by repository, so it should be treated as
suggestive rather than definitive.

Raw snippets alone were not sufficient. Negative boundaries improved set precision
relative to positive examples alone, but the full semantic card remained the safer
default.

Recommended Area Card fields:

- stable area ID and human-readable name;
- concise ownership description;
- positive inclusions;
- explicit exclusions;
- confusing neighboring areas;
- multi-area activation rules;
- representative paths and symbols;
- one short representative snippet or code summary.

## Experiment 5: automated onboarding

Dataset: 58 real development tasks.

| Registry source | Active MAE | Cosine | Active F1 | Top-area agreement | Reference unknown |
| -- | --: | --: | --: | --: | --: |
| Existing human registry | 0.0822 | 0.8564 | 0.8333 | 92.9% | 0.3035 |
| Rule-guided Sol generation | 0.0611 | 0.9215 | 0.8850 | 96.1% | 0.1691 |
| Unconstrained Sol generation | 0.0630 | 0.9620 | 0.8138 | 98.2% | 0.0910 |

The rule-guided draft was the best balanced generated registry. The unconstrained
draft achieved higher cosine and top-area agreement but lower active F1, consistent
with broader or more overlapping ownership.

These numbers must not be interpreted as proof that automated onboarding beats human
onboarding. The registry generator saw many of the same development tasks later used
for evaluation:

- all seven Grafana evaluation tasks were visible during generation;
- sixteen of seventeen Kubernetes tasks were visible;
- sixteen of thirty-four Backstage tasks were visible.

The generated registries also reveal task-list overfitting. For example, the
rule-guided Grafana registry contains narrow areas such as frontend RUM telemetry,
time-range navigation, and text-panel rendering rather than stable coverage of the
whole repository.

The valid product conclusion is narrower: constrained generation can create
classifiable drafts and should be tested as an onboarding assistant. A held-out
evaluation and human coverage review are required before automatic acceptance.

## Product recommendation

For the first product:

1. During onboarding, generate eight flat, repository-specific areas with the
   rule-guided prompt.
2. Reject drafts with aliases, catch-alls, or parent-child pairs at the same level.
3. Permit overlap only when two implementation responsibilities genuinely change.
4. Ask the user to review names, inclusions, exclusions, and missing responsibilities.
5. Attach representative repository anchors and at most one short snippet per area.
6. Run a small onboarding validation suite of held-out or newly generated hard tasks.
7. Warn when the registry produces excessive unknown mass, excessive simultaneous
   activations, or poor Luna-versus-Sol agreement.
8. Keep `unknown_probability` separate from the known-area scores at runtime.

## Reproducibility

| Experiment | Jobs | Provider cost | Manifest hash |
| -- | --: | --: | -- |
| Common reference | 600 | $13.3084 | `78a317ef0ddeb060817011c4f93f2740bfa7976fe08712fa385d051bd4ea00b0` |
| Unknown benchmark | 360 | $7.5924 | `465b65e248d0eec8146992dbe465f4b27f384cc590eb43859011933510ae0ea8` |
| Structure matrix | 1,400 | $40.3291 | `0732f676fdd9c72b830634c50846839dc7bd1a2e50e6f4a8a513b88f50bd1ffe` |
| Area Card ablation | 900 | $5.2832 | `c4f8a28ebe274d0a26d8846db58ca46d2af59ef2f75a10f233cd3b6f3b27b1d3` |
| Generation comparison | 348 | $6.7772 | `d2df5aee1e1061264afaef37e83e873449ff48c1922ad9453c245e7ce57f3da3` |

The frozen manifests are in
`apps/experiment-platform/examples/onboarding-followups/`. Combined local metrics are
in the gitignored
`.routekit-experiment-assets/onboarding-followups-20260819/results/` directory, while
the platform retains immutable reports, metrics, inputs, and job artifacts in private
Vercel Blob storage.
