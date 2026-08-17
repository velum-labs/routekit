# Proposed RouteKit routing-area catalog

Status: **proposal for review; not approved for production publication**

This directory defines a first stable semantic catalog for compositional
eval-driven routing. It describes the kinds of RouteKit maintainer and support
requests that the current repository can ground and evaluate. It does not
select a model, encode model performance, or imply that the proposed areas have
already passed classifier or model-discrimination qualification.

The machine-readable catalog and seed benchmarks live in:

```text
packages/testkit/src/eval-routing-v2/fixtures/
  routekit-area-catalog.v1.json
  classifier-benchmark.v1.json
  eval-case-specifications.v1.json
```

## Proposed areas

| Area | Positive boundary | Important negative boundary |
| --- | --- | --- |
| `gateway-protocols` | HTTP compatibility, streaming, tools, protocol translation | Model/provider selection policy |
| `model-routing-registry` | Namespaced model discovery, defaults, routes, availability | Account scheduling and protocol encoding |
| `subscription-pooling` | Account enrollment, quota, eligibility, rotation, retry | Generic model routing and request attribution |
| `daemon-control-operations` | Singleton lifecycle, control plane, configuration, health | Remote enrollment and data-plane protocol behavior |
| `remote-gateways-security` | SSH enrollment, peer authorization, tokens, TLS and bind safety | Local lifecycle and ordinary client authentication |
| `eval-driven-routing` | Suite authoring, comparison, evidence, publication, `model: auto` | General model discovery and call telemetry |
| `client-tool-integration` | Codex, Claude Code, Cursor, OpenCode, client-specific setup | Provider internals and generic gateway semantics |
| `observability-attribution` | Call IDs, usage, cost, attempts, account attribution, privacy | Scheduling decisions and eval quality scoring |

These are product-domain areas, not request-envelope capabilities. Tools,
vision, endpoint protocol, context length, and output limits remain hard
requirements derived outside the semantic classifier.

## Why these areas

The catalog follows repository ownership and user-visible concepts closely
enough that each area can have grounded eval cases and maintained source
anchors. The negative boundaries are deliberate:

- gateway encoding is separate from deciding which route to use;
- account-pool scheduling is separate from model-route selection;
- remote enrollment security is separate from local daemon lifecycle;
- eval quality evidence is separate from operational call telemetry; and
- client adaptation is separate from the provider implementation behind it.

Some real requests necessarily span areas. The classifier should represent
those requests as mixtures rather than force a single label. The seed benchmark
therefore includes single-area, composite, ambiguous, unknown, and
prompt-injection cases.

## Approval criteria

Before this catalog is published, reviewers should require:

1. stable ownership and source anchors for every area;
2. reviewed definitions, inclusions, exclusions, and counterexamples;
3. acceptable single-area and mixture-vector classifier measurements;
4. acceptable unknown detection and repeated-run stability;
5. at least 20 reviewed model-eval cases per area;
6. complete candidate-by-area evidence; and
7. a demonstrated material model-ranking or operational difference for each
   area used to make routing decisions.

An area that classifies cleanly but does not change model choice may remain a
reporting dimension, but should not add routing complexity. Areas that remain
consistently confused should be merged or have their boundaries rewritten.

## Fixture interpretation

Classifier fixture targets are review hypotheses, not provider responses or
golden snapshots. Every target contains all configured area IDs plus
`unknownWeight`, and the values sum to one. The benchmark can score exact
vector error while also applying less brittle dominant-area and unknown
thresholds.

The eval-case specifications are similarly seeds. They describe what a future
authored case must exercise and how it should be judged, but contain no canned
model answer. They must not be treated as sufficient production evidence until
expanded and reviewed.
