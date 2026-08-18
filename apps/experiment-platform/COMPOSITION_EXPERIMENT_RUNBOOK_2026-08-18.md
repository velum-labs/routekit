# Luna composition experiment runbook

Status: prepared for deployment and paid execution approval. This runbook does not authorize a model call.

## Question

Can direct Luna classification produce the routing contract below closely enough to a
GPT-5.6 Sol reference?

```json
{
  "area_composition_scores": {
    "backend": 0.9,
    "authentication": 0.75,
    "frontend": 0.05
  },
  "unknown_probability": 0.12
}
```

Known-area scores are independent task-composition intensities. They do not need to sum to
one. `unknown_probability` is a separate estimate that the registered areas fail to cover at
least one material task responsibility.

## Treatments

Every task receives the same task-aware context, enriched Area Cards, and available repository
evidence.

1. `sol_reference`: GPT-5.6 Sol with the anchored rubric and internal responsibility
   decomposition.
2. `luna_current`: the prior “probability an area is materially required” semantics, adapted to
   the new output contract.
3. `luna_continuous`: explicit continuous responsibility scores without detailed anchors.
4. `luna_anchored`: continuous scores with 0.00/0.25/0.50/0.75/1.00 anchors.
5. `luna_anchored_decomposition`: anchored scoring after an internal responsibility
   decomposition.

All responses use a strict JSON Schema that requires every registered area and forbids
additional fields.

## Development data

Frozen dataset ID: `composition-development-100-v1`

- 100 tasks total;
- 58 real issue-grounded tasks;
- 42 explicitly marked synthetic composite tasks;
- 60 Backstage, 30 Kubernetes, and 10 Grafana tasks;
- task-aware context only;
- no Backstage locked-test tasks;
- no RouteKit locked-test data;
- no hard area labels in model inputs.

The synthetic tasks combine two grounded requests from the same repository to increase
multi-area and partial-unknown coverage. They do not claim to represent a single historical
repository snapshot.

## Metrics

Candidate vectors are paired with the Sol vector for the same task and seed.

- strict-contract validity;
- cosine similarity;
- mean absolute error over all areas;
- active- and inactive-area mean absolute error;
- active-area precision, recall, and F1 using a Sol score of `0.25` as active;
- top-area agreement;
- top-two overlap;
- whether all Sol-active areas appear in Luna’s top three;
- unknown-probability mean absolute error;
- unknown threshold agreement at `0.3`, `0.5`, and `0.7`;
- latency and provider/infrastructure cost.

## Prepared manifests

- `examples/composition/canary.yaml`: 10 tasks × 5 treatments = 50 hosted calls.
- `examples/composition/development.yaml`: 100 tasks × 5 treatments = 500 hosted calls.

Both manifests:

- use development data only;
- require `paid_execution` approval;
- run with at most two hosted calls in flight;
- reference immutable task artifacts;
- do not run automatically merely because they exist in the repository.

## Operator sequence

Use the project credentials from the documented local environment. Never print them.

```bash
pnpm --filter @velum-labs/routekit-experiment-platform composition:prepare
pnpm --filter @velum-labs/routekit-experiment-platform composition:upload
pnpm --filter @velum-labs/routekit-experiment-platform composition:manifests -- \
  --image '<immutable-runner-image>' \
  --source-commit '<implementation-commit>'
```

After deployment and explicit approval to spend:

```bash
pnpm experiments:cli submit apps/experiment-platform/examples/composition/canary.yaml
pnpm experiments:cli approve luna-composition-canary-10-v1 paid_execution
```

Do not submit the 100-task manifest until the canary has:

- all 50 jobs successful;
- valid contracts from both models;
- a complete composition metrics artifact and Markdown report;
- no unexpected provider/model substitution;
- actual spend within the manifest limits.

Submitting a manifest creates an awaiting-approval record; approving
`paid_execution` starts paid inference.
