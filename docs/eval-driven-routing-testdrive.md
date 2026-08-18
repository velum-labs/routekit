# Eval-driven automatic routing

RouteKit has one automatic-routing protocol. It does not classify requests onto
preselected model choices.

## Data flow

```text
request text + reviewed workload-dimension definitions
                    |
                    v
      normalized request decomposition + unknown weight
                    |
                    v
  deterministic scoring(model × dimension evidence,
                        request requirements,
                        user objective)
                    |
                    v
          selected model + ranked fallbacks
```

The classifier input contains only request text and the workload-dimension
definitions and boundaries. It never receives model IDs, selected models,
fallback models, prices, model measurements, evidence, or previous winners.

Hard requirements such as endpoint compatibility, tools, vision, context, and
maximum output are enforced deterministically. Quality, cost, and latency
objectives are also evaluated deterministically from the published evidence
matrix. Unknown pricing is unavailable evidence, not zero cost.

## Current reviewed routing basis

The live testdrive covers these eight workload dimensions:

1. gateway protocols;
2. model routing and registry;
3. subscription pooling;
4. daemon and control operations;
5. remote gateways and security;
6. eval-driven routing;
7. client and tool integration;
8. observability and attribution.

The checked-in definitions include positive scope, exclusions, and boundary
examples. The classifier must emit one weight for every dimension plus
`unknownWeight`, and the complete vector must sum to one.

## Evidence and publication

Each workload dimension has an authoritative `routekit.eval-manifest.json`
identifying:

- candidate models;
- judge model;
- case identities and case count;
- maximum output tokens;
- expected candidate and judge call count.

Publication fails closed unless every configured candidate has exactly one
judged result for every expected case and the observed candidates, judge,
suite digest, and dimension identity match the manifest. Missing, duplicate,
unknown, cutoff, or unjudged rows cannot publish.

The complete model-by-dimension evidence matrix is stored in
`$ROUTEKIT_HOME/eval/published-routing.json`. `model: auto` reads this
snapshot, classifies the request, and performs deterministic selection. Eval
traffic itself must always name explicit models and cannot recurse through the
auto-router.

## Qualification level

The billed testdrive authors five real cases per dimension and exercises all
eight dimensions with Luna, Terra, and Sol. This validates the workflow and
its fail-closed invariants.

It is not production activation evidence. Production approval requires at
least 20 reviewed model-eval cases per dimension, the complete resulting
model-by-dimension evidence matrix, and a successful full live routing
qualification.

See [Live billed eval-routing qualification](eval-routing-live-e2e.md) for the
command, call plan, retained artifacts, and passing contract.
