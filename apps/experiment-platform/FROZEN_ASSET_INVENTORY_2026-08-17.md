# Frozen coding-router asset inventory — August 17, 2026

All objects below are in the private Blob store attached to
`routekit-experiments-development`. They contain no locked-test data.

## Datasets

| Role | Cases | Size | SHA-256 | Blob path |
| -- | --: | --: | -- | -- |
| Development | 24 | 315,392 bytes | `f4cc23e119108f6c7d2d8c31cd616841633f8ec59fef29cb53ee8cec41fda660` | `datasets/natural-hard-v2-development-24/sha256/f4/f4cc23e119108f6c7d2d8c31cd616841633f8ec59fef29cb53ee8cec41fda660.tar.zst` |
| Confirmation | 24 | 274,949 bytes | `0bfbe9f4342fc6e0836d48481b1a848c251a32b1f986c20f57ff79e70f60708d` | `datasets/natural-hard-v2-confirmation-24/sha256/0b/0bfbe9f4342fc6e0836d48481b1a848c251a32b1f986c20f57ff79e70f60708d.tar.zst` |

Each dataset archive contains task-aware episodes, separately stored silver labels,
repository profiles, Area Cards, and frozen retrieval outputs. The development and confirmation
partitions are disjoint.

## Exact repository snapshots

| Repository | Snapshots | Size | SHA-256 | Blob path |
| -- | --: | --: | -- | -- |
| `kubernetes/kubernetes` | 41 | 72,014,558 bytes | `737fbb994f40f78d61e75c94d77c52ab3a01f8b3ad6bfc0811ea77784f32f4a8` | `repositories/kubernetes-kubernetes-snapshots/sha256/73/737fbb994f40f78d61e75c94d77c52ab3a01f8b3ad6bfc0811ea77784f32f4a8.tar.zst` |
| `grafana/grafana` | 7 | 92,287,906 bytes | `61cf1fe8ae36284501195ef7e3564d19ff15c97d74e63a81090604def70cbb12` | `repositories/grafana-grafana-snapshots/sha256/61/61cf1fe8ae36284501195ef7e3564d19ff15c97d74e63a81090604def70cbb12.tar.zst` |

The stores are shallow bare Git repositories with one exact pre-task snapshot ref per required
commit. Every snapshot was verified with `git cat-file` and `git archive` before packaging.

## Hosted-model task inputs

The platform contains 48 individual JSON artifacts totaling 5,037,130 bytes:

- 24 under `inputs/natural-hard-v2-development-24/<task>/sha256/<prefix>/<hash>.json`;
- 24 under `inputs/natural-hard-v2-confirmation-24/<task>/sha256/<prefix>/<hash>.json`.

Each input has treatment-specific requests for:

- `direct`;
- `evidence_first`;
- `independent_per_area`.

Every request uses task-aware context, enriched Area Cards, hybrid-rerank retrieval, eight short
evidence snippets, strict distributional JSON output, and high reasoning with
`openai/gpt-5.6-luna`. Labels are absent from the request content and appear only in manifest
task metadata.

## Safeguards

- `lockedTestDataIncluded=false`;
- development role is active;
- confirmation data requires both paid-execution and confirmation approvals;
- task inputs use no latest-request-only representation;
- no experiment was submitted while preparing or uploading these assets.
