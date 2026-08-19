# Onboarding area-registry optimization results

Date: 2026-08-19

## Executive summary

This campaign completed 21 Vercel experiment runs and 2857 jobs for $79.3114 in model inference and $0.0000 in measured infrastructure cost.

The runtime classifier was fixed throughout the evaluation: direct Luna classification, task-aware context, independent known-area composition scores, and a separate unknown probability. Only the onboarding registry changed.

The central result is that there was no universal best construction recipe. Backstage preferred a hybrid task-plus-structure registry, Grafana preferred the same hybrid with changed-path statistics, and Kubernetes benefited from the largest diverse history. Registry repair remained structurally valid, but its classification effect must be judged repository by repository rather than assumed positive.

On the untouched public final test, repaired registries had the best aggregate Luna-versus-Sol active MAE (0.0835), while selected registries had the lowest unknown error (0.0106) and best Luna-versus-Claude active MAE (0.1248). Those improvements were not statistically decisive over the human baselines on all 84 tasks because the repositories behaved differently. On the deliberately hard 48-task cohort, however, both selected and repaired registries clearly outperformed human registries.

The weakest result was the 45-task real conversational cohort: active MAE was 0.1758 and unknown MAE was 0.2462. Non-diagnostic conversational tasks were harder than diagnostic tasks. The first product should therefore use candidate generation plus nested validation, and should not assume that an automatically generated registry is ready without repository-specific checks.

Two canaries ended in a failed state only because measured provider cost exceeded an overly tight budget by less than one cent. Every job and every composition contract in those canaries succeeded; full-run budgets were corrected before execution.

## Validation-selected onboarding recipes

| Repository | Selected recipe | Selection score ↓ | Active MAE ↓ | Unknown MAE ↓ | Active F1 ↑ |
| -- | -- | --: | --: | --: | --: |
| backstage/backstage | hybrid_40_recent | 0.1065 | 0.1010 | 0.0075 | 0.8833 |
| grafana/grafana | hybrid_paths_40_recent | 0.0809 | 0.0479 | 0.0504 | 0.9250 |
| kubernetes/kubernetes | hybrid_paths_80_diverse | 0.1132 | 0.0653 | 0.0712 | 0.9034 |

The selection score was fixed before final-test exposure: active MAE + 0.50 × unknown MAE + 0.15 × reference unknown, plus structural penalties. Human and previous-unconstrained registries were retained as baselines but were not eligible to win.

## Untouched 84-task final test

| Registry | Pairs | Active MAE vs Sol ↓ | Cosine vs Sol ↑ | Active F1 ↑ | Top area ↑ | All active @3 ↑ | Unknown MAE ↓ | Active MAE vs Claude ↓ | Sol–Claude active MAE ↓ |
| -- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| human | 84 | 0.1041 | 0.8281 | 0.8587 | 88.1% | 98.8% | 0.1204 | 0.1572 | 0.1950 |
| previous_unconstrained | 84 | 0.0944 | 0.9088 | 0.7917 | 84.5% | 97.6% | 0.1611 | 0.1623 | 0.1482 |
| repaired | 84 | 0.0835 | 0.9674 | 0.9000 | 97.6% | 90.5% | 0.0171 | 0.1386 | 0.1497 |
| selected | 84 | 0.0935 | 0.9488 | 0.8563 | 94.0% | 91.7% | 0.0106 | 0.1248 | 0.1443 |

Luna-versus-Sol measures runtime classifiability. Luna-versus-Claude checks whether the conclusion is robust to an independent judge. Sol–Claude disagreement is label ambiguity, not a Luna error.

### Paired active-MAE differences

Negative favors the first registry. Intervals are deterministic task-level bootstrap intervals.

| Comparison | Mean delta | 95% interval |
| -- | --: | --: |
| selected − human | -0.0106 | [-0.0579, 0.0371] |
| repaired − selected | -0.0100 | [-0.0398, 0.0140] |
| repaired − human | -0.0206 | [-0.0661, 0.0233] |
| selected − previous unconstrained | -0.0009 | [-0.0462, 0.0469] |

### Final results by repository

| Repository | Registry | Active MAE vs Sol ↓ | Active F1 ↑ | Top area ↑ | Unknown MAE ↓ | Active MAE vs Claude ↓ |
| -- | -- | --: | --: | --: | --: | --: |
| backstage/backstage | human | 0.0135 | 0.8929 | 96.4% | 0.1506 | 0.1041 |
| backstage/backstage | previous_unconstrained | 0.0452 | 0.8690 | 89.3% | 0.1165 | 0.1623 |
| backstage/backstage | repaired | 0.1021 | 0.8512 | 100.0% | 0.0088 | 0.1420 |
| backstage/backstage | selected | 0.0862 | 0.8869 | 100.0% | 0.0103 | 0.0977 |
| grafana/grafana | human | 0.1445 | 0.8619 | 82.1% | 0.1014 | 0.1793 |
| grafana/grafana | previous_unconstrained | 0.1082 | 0.8810 | 89.3% | 0.0918 | 0.1628 |
| grafana/grafana | repaired | 0.0810 | 0.8726 | 96.4% | 0.0380 | 0.1276 |
| grafana/grafana | selected | 0.0922 | 0.7893 | 89.3% | 0.0134 | 0.1289 |
| kubernetes/kubernetes | human | 0.1543 | 0.8214 | 85.7% | 0.1092 | 0.1881 |
| kubernetes/kubernetes | previous_unconstrained | 0.1299 | 0.6250 | 75.0% | 0.2751 | 0.1618 |
| kubernetes/kubernetes | repaired | 0.0675 | 0.9762 | 96.4% | 0.0046 | 0.1462 |
| kubernetes/kubernetes | selected | 0.1021 | 0.8929 | 92.9% | 0.0083 | 0.1479 |

Backstage's human registry was easiest for Luna on active-area scores, while repaired registries were strongest on Grafana and Kubernetes. This heterogeneity is why onboarding should select per repository rather than hard-code one generation recipe.

## Natural hard and open-set cohort

| Registry | Pairs | Active MAE vs Sol ↓ | Cosine vs Sol ↑ | Active F1 ↑ | Top area ↑ | All active @3 ↑ | Unknown MAE ↓ | Active MAE vs Claude ↓ | Sol–Claude active MAE ↓ |
| -- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| human | 48 | 0.1621 | 0.8140 | 0.6528 | 77.1% | 97.9% | 0.1969 | n/a | n/a |
| repaired | 48 | 0.0713 | 0.9665 | 0.8951 | 95.8% | 100.0% | 0.0449 | n/a | n/a |
| selected | 48 | 0.0702 | 0.9565 | 0.8160 | 97.9% | 97.9% | 0.0248 | n/a | n/a |

This 48-task cohort contains requests without exact paths or area names, multi-area tasks, open-set work, and cases requiring repository interpretation.

| Comparison | Mean active-MAE delta | 95% interval |
| -- | --: | --: |
| selected − human | -0.0919 | [-0.1621, -0.0260] |
| repaired − selected | 0.0011 | [-0.0186, 0.0202] |
| repaired − human | -0.0908 | [-0.1570, -0.0318] |

### Unknown detection on natural hard cases

| Registry | Unknown MAE ↓ | Unknown Brier ↓ | Accuracy @0.3 ↑ | False unknown @0.3 ↓ | Missed unknown @0.3 ↓ |
| -- | --: | --: | --: | --: | --: |
| human | 0.1969 | 0.1301 | 79.2% | 10.4% | 10.4% |
| repaired | 0.0449 | 0.0066 | 93.8% | 4.2% | 2.1% |
| selected | 0.0248 | 0.0015 | 97.9% | 0.0% | 2.1% |

## Real conversational coding prompts

| Registry | Pairs | Active MAE vs Sol ↓ | Cosine vs Sol ↑ | Active F1 ↑ | Top area ↑ | All active @3 ↑ | Unknown MAE ↓ | Active MAE vs Claude ↓ | Sol–Claude active MAE ↓ |
| -- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| auto | 45 | 0.1758 | 0.8766 | 0.6674 | 80.0% | 77.8% | 0.2462 | 0.1732 | 0.1930 |

These 45 tasks preserve task-aware conversational context from separate Codex accounts. They include short continuation requests, debugging follow-ups, incomplete specifications, and repository-specific language.

Diagnostic conversational tasks had active MAE 0.1583; non-diagnostic tasks had active MAE 0.2020. Their unknown MAEs were 0.1993 and 0.3165, respectively.

## Human-assisted RouteKit onboarding proxy

### Three-task validation before repair

| Registry | Pairs | Active MAE vs Sol ↓ | Cosine vs Sol ↑ | Active F1 ↑ | Top area ↑ | All active @3 ↑ | Unknown MAE ↓ | Active MAE vs Claude ↓ | Sol–Claude active MAE ↓ |
| -- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| auto | 3 | 0.2312 | 0.9512 | 0.2667 | 100.0% | 66.7% | 0.3850 | n/a | n/a |
| human | 3 | 0.2894 | 0.8263 | 0.4841 | 100.0% | 33.3% | 0.4600 | n/a | n/a |

### Five held-out tasks after repair

| Registry | Pairs | Active MAE vs Sol ↓ | Cosine vs Sol ↑ | Active F1 ↑ | Top area ↑ | All active @3 ↑ | Unknown MAE ↓ | Active MAE vs Claude ↓ | Sol–Claude active MAE ↓ |
| -- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| auto | 5 | 0.2515 | 0.9085 | 0.6357 | 40.0% | 20.0% | 0.3620 | n/a | n/a |
| human | 5 | 0.2027 | 0.9163 | 0.4846 | 60.0% | 40.0% | 0.2940 | n/a | n/a |
| repaired | 5 | 0.2260 | 0.9249 | 0.5872 | 100.0% | 40.0% | 0.2280 | n/a | n/a |

| Comparison | Mean active-MAE delta | 95% interval |
| -- | --: | --: |
| auto − human | 0.0488 | [-0.0865, 0.2030] |
| repaired − auto | -0.0255 | [-0.1312, 0.0841] |
| repaired − human | 0.0233 | [-0.1042, 0.1763] |

Actual engineer review time, edit count, and satisfaction remain unmeasured. A blinded private review packet was generated for human completion.

## Validation learning matrix

| Registry recipe | Structurally valid repos | Mean unpenalized objective ↓ | Active MAE ↓ | Unknown MAE ↓ | Active F1 ↑ | Top area ↑ | Reference unknown |
| -- | --: | --: | --: | --: | --: | --: | --: |
| hybrid_paths_40_diverse_10areas | 2/3 | 0.1063 | 0.0790 | 0.0357 | 0.8821 | 86.1% | 0.0627 |
| hybrid_paths_40_recent | 2/3 | 0.1097 | 0.0781 | 0.0478 | 0.8565 | 88.9% | 0.0512 |
| hybrid_paths_80_diverse | 2/3 | 0.1236 | 0.0958 | 0.0411 | 0.8972 | 88.9% | 0.0486 |
| hybrid_paths_20_diverse | 2/3 | 0.1264 | 0.0931 | 0.0396 | 0.8502 | 83.3% | 0.0902 |
| hybrid_paths_40_diverse_6areas | 3/3 | 0.1275 | 0.0966 | 0.0483 | 0.8741 | 91.7% | 0.0453 |
| hybrid_paths_10_diverse | 3/3 | 0.1454 | 0.0927 | 0.0717 | 0.8162 | 91.7% | 0.1119 |
| hybrid_40_recent | 3/3 | 0.1579 | 0.1262 | 0.0424 | 0.8495 | 86.1% | 0.0698 |
| hybrid_paths_5_diverse | 2/3 | 0.1669 | 0.1068 | 0.0849 | 0.8794 | 86.1% | 0.1176 |
| previous_unconstrained | 3/3 | 0.1720 | 0.0841 | 0.1129 | 0.8962 | 88.9% | 0.2096 |
| structure_only | 2/3 | 0.1742 | 0.1243 | 0.0713 | 0.8192 | 86.1% | 0.0953 |
| hybrid_paths_40_diverse_rules | 3/3 | 0.1747 | 0.1221 | 0.0803 | 0.9108 | 91.7% | 0.0830 |
| hybrid_paths_40_diverse_b | 3/3 | 0.1765 | 0.1152 | 0.0868 | 0.8947 | 86.1% | 0.1187 |
| hybrid_paths_40_diverse_a | 3/3 | 0.1927 | 0.1042 | 0.1341 | 0.8199 | 88.9% | 0.1431 |
| tasks_only_40_recent | 3/3 | 0.2185 | 0.1313 | 0.1067 | 0.8165 | 77.8% | 0.2256 |
| human | 3/3 | 0.2347 | 0.1014 | 0.1663 | 0.8093 | 83.3% | 0.3349 |

The unpenalized objective uses the same error terms as selection but omits the hard structural penalty. Recipes that were structurally invalid in any repository were never eligible there, even if their average classification metrics looked good. Use this matrix for onboarding guidance rather than treating one prompt recipe as universally optimal.

## Product guidance supported by the campaign

1. Generate several registry candidates during onboarding rather than a single draft.
2. Always include repository structure and test whether changed-path statistics help.
3. Use a small nested validation set to select among candidates; do not choose only by how plausible the cards look.
4. Evaluate six, eight, and ten areas as candidate cuts, then reject catch-alls, aliases, and parent-child areas at the same runtime level.
5. Use diverse historical tasks, but do not assume more history is always better. The selected amount varied by repository.
6. Treat automated repair as an optional candidate, not an automatic promotion. Promote it only when validation or final evidence shows an improvement.
7. Preserve a separate unknown probability and evaluate natural open-set cases before launch.

## Luna runtime characteristics in these runs

| Cohort | Registry | Median Luna latency | Luna inference cost per task |
| -- | -- | --: | --: |
| Final | human | 5360 ms | $0.0015 |
| Final | previous_unconstrained | 4394 ms | $0.0014 |
| Final | repaired | 4718 ms | $0.0018 |
| Final | selected | 4359 ms | $0.0017 |
| Natural hard | human | 7982 ms | $0.0018 |
| Natural hard | repaired | 6080 ms | $0.0021 |
| Natural hard | selected | 5783 ms | $0.0019 |
| Real conversation | auto | 6535 ms | $0.0016 |

Latency was measured through the hosted Vercel workflow and includes provider response time; it is not a local-only model benchmark. The observed Luna inference cost stayed near $0.0014–$0.0021 per classification.

## Execution cost and integrity

| Experiment | Status | Jobs | Provider cost | Provider budget | Budget exceeded |
| -- | -- | --: | --: | --: | -- |
| onboarding-optimization-construction-canary-v1 | completed | 1 | $0.2828 | $0.57 | no |
| onboarding-optimization-private-registries-4-v1 | completed | 4 | $0.7789 | $2.30 | no |
| onboarding-optimization-neutral-canary-6-v1 | completed | 6 | $0.2432 | $0.35 | no |
| onboarding-optimization-public-registries-3x13-v1 | completed | 39 | $10.6568 | $22.42 | no |
| onboarding-optimization-neutral-93-v1 | completed | 93 | $4.1672 | $5.35 | no |
| onboarding-optimization-construction-retry-3-v1 | completed | 3 | $0.5970 | $2.07 | no |
| onboarding-optimization-validation-canary-3x15-v1 | completed | 90 | $2.1284 | $2.48 | no |
| onboarding-optimization-neutral-retry-2-v1 | completed | 2 | $0.2773 | $0.69 | no |
| onboarding-optimization-neutral-insufficient-retry-1-v1 | completed | 1 | $0.0032 | $0.18 | no |
| onboarding-optimization-validation-36x15-v1 | completed | 1080 | $23.2364 | $29.81 | no |
| onboarding-optimization-repair-3-v1 | completed | 3 | $0.8319 | $1.73 | no |
| onboarding-optimization-final-canary-3x4x3-v1 | failed | 36 | $0.8746 | $0.87 | yes |
| onboarding-optimization-natural-hard-canary-2x3-v1 | completed | 12 | $0.2774 | $0.33 | no |
| onboarding-optimization-real-auto-canary-4-v1 | failed | 12 | $0.2996 | $0.29 | yes |
| onboarding-optimization-routekit-assistance-validation-3x2-v1 | completed | 12 | $0.3049 | $0.33 | no |
| onboarding-optimization-routekit-assistance-repair-1-v1 | completed | 1 | $0.2128 | $0.58 | no |
| onboarding-optimization-final-84x4x3-v1 | completed | 1008 | $23.1300 | $30.69 | no |
| onboarding-optimization-natural-hard-48x3-v1 | completed | 288 | $6.8193 | $7.95 | no |
| onboarding-optimization-real-auto-45-v1 | completed | 135 | $3.3901 | $4.11 | no |
| onboarding-optimization-routekit-assistance-final-5x3-v1 | completed | 30 | $0.7963 | $0.83 | no |
| onboarding-optimization-final-retry-1-v1 | completed | 1 | $0.0035 | $0.03 | no |

Total provider cost: $79.3114.

All final and cohort jobs succeeded. One Luna final-test response spent its original completion allowance entirely on hidden reasoning and emitted no JSON; it was rerun with the same prompt and a larger completion allowance, then overlaid transparently in these aggregate metrics.

## Limitations

- The public final test covers three large repositories, while the real conversational cohort is smaller and uneven across four private repositories.
- Sol is the primary mapping reference. Claude provides an independent audit but is not a human gold label.
- Registry selection used only twelve validation tasks per public repository, so close recipes should be treated as a small Pareto set.
- The onboarding assistance experiment is a proxy until engineers record review time, edits, and preference.
- The campaign tests whether Luna can classify the registry, not whether downstream model-performance estimates are additive or whether the router selects the optimal model.

Private aggregate metrics and the blinded RouteKit review packet are stored under `.routekit-experiment-assets/onboarding-optimization-20260819/results/`.
