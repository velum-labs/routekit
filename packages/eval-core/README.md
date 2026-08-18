# @velum-labs/routekit-eval-core

Effect execution and aggregation for RouteKit evaluations. Candidate and judge
calls use a dedicated token, explicit model IDs, attribution metadata, and a
policy-bypass header so evaluation cannot recursively invoke the auto-router.
The online request path never imports this package.

The `./experiment` entry point contains deterministic manifest hashing, paired
job expansion, local command execution, cost estimation, progress summaries,
and Markdown reporting without importing the online RouteKit runtime.
