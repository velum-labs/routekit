# Proposed RouteKit routing basis

Status: **live testdrive qualified; not approved for production activation**

This directory defines a first stable semantic routing basis for compositional
eval-driven routing. It describes the kinds of RouteKit maintainer and support
requests that the current repository can ground and evaluate. It does not
select a model, encode model performance, or imply that the proposed dimensions
have already passed classifier or model-discrimination qualification.

The machine-readable routing basis and seed benchmarks live in:

```text
packages/testkit/src/eval-routing-compositional/fixtures/
  routing-basis.json
  decomposition-benchmark.json
  dimension-suite-specifications.json
```

## Proposed workload dimensions

| Workload dimension | Positive boundary | Important negative boundary |
| --- | --- | --- |
| `gateway-protocols` | HTTP compatibility, streaming, tools, protocol translation | Model/provider selection policy |
| `model-routing-registry` | Namespaced model discovery, defaults, routes, availability | Account scheduling and protocol encoding |
| `subscription-pooling` | Account enrollment, quota, eligibility, rotation, retry | Generic model routing and request attribution |
| `daemon-control-operations` | Singleton lifecycle, control plane, configuration, health | Remote enrollment and data-plane protocol behavior |
| `remote-gateways-security` | SSH enrollment, peer authorization, tokens, TLS and bind safety | Local lifecycle and ordinary client authentication |
| `eval-driven-routing` | Suite authoring, comparison, evidence, publication, `model: auto` | General model discovery and call telemetry |
| `client-tool-integration` | Codex, Claude Code, Cursor, OpenCode, client-specific setup | Provider internals and generic gateway semantics |
| `observability-attribution` | Call IDs, usage, cost, attempts, account attribution, privacy | Scheduling decisions and eval quality scoring |

These are semantic workload dimensions, not request-envelope capabilities.
Tools, vision, endpoint protocol, context length, and output limits remain
hard requirements derived outside the semantic classifier.

## Why these dimensions

The routing basis follows repository ownership and user-visible concepts
closely enough that each dimension can have grounded eval cases and maintained
source anchors. The negative boundaries are deliberate:

- gateway encoding is separate from deciding which route to use;
- account-pool scheduling is separate from model-route selection;
- remote enrollment security is separate from local daemon lifecycle;
- eval quality evidence is separate from operational call telemetry; and
- client adaptation is separate from the provider implementation behind it.

Some real requests necessarily span dimensions. The classifier should represent
those requests as mixtures rather than force a single class. The seed benchmark
therefore includes single-dimension, composite, ambiguous, unknown, and
prompt-injection cases.

The first complete eight-dimension billed qualification passed on August 17,
2026. Its exact generated evals and sanitized structured results are committed
under:

```text
docs/evidence/eval-routing/2026-08-18-866a9716e888/
```

That run used five authored cases per dimension, which qualifies the testdrive
but does not satisfy the production-activation threshold below.

## Approval criteria

Before this routing basis is activated, reviewers should require:

1. stable ownership and source anchors for every dimension;
2. reviewed definitions, inclusions, exclusions, and counterexamples;
3. acceptable single-dimension and mixture-vector classifier measurements;
4. acceptable unknown detection and repeated-run stability;
5. at least 20 reviewed model-eval cases per dimension;
6. complete model-by-dimension evidence; and
7. a demonstrated material model-ranking or operational difference for each
   dimension used to make routing decisions.

A dimension that classifies cleanly but does not change model choice may remain
a reporting dimension, but should not add routing complexity. Dimensions that
remain consistently confused should be merged or have their boundaries
rewritten.

## Fixture interpretation

Classifier fixture targets are review hypotheses, not provider responses or
golden snapshots. Every target contains all configured dimension IDs plus
`unknownWeight`, and the values sum to one. The benchmark can score exact
vector error while also applying less brittle dominant-dimension and unknown
thresholds.

The eval-case specifications are similarly seeds. They describe what a future
authored case must exercise and how it should be judged, but contain no canned
model answer. They must not be treated as sufficient production evidence until
expanded and reviewed.
