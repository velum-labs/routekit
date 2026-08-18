# Compositional eval routing

Status: active architecture

## Purpose

RouteKit separates request understanding, model measurement, and user policy:

```text
request
  -> semantic request decomposition
  -> hard request requirements
  -> model x workload-dimension evidence
  -> deterministic objective
  -> selected model and fallbacks
```

The language-model classifier does not receive model IDs, prices, evidence,
precomputed winners, or fallbacks. It produces no routing recommendation.

## Routing basis

A production routing basis contains five to ten reviewed, stable workload dimensions. Agent
discovery may propose a dimension, but cannot publish one without review. Each dimension
has a stable lowercase ID, a bounded definition, positive boundaries, and
negative boundaries.

A dimension is useful for routing only when it is:

1. semantically separable from the other dimensions; and
2. associated with materially different model performance or operational
   characteristics.

Routing bases and definitions are versioned and content-digested. Production
classification always records the definition-set digest.

## Request decomposition

The classifier returns one non-negative weight for every configured dimension plus a
mandatory `unknownWeight`. Every value is finite and in `[0, 1]`; the complete
vector sums to one within a fixed numeric tolerance. The vector is a semantic
mixture, not a model probability distribution and not a model selection.

No free-form classifier rationale is accepted or persisted. The classifier
uses strict structured output. Unknown, missing, or duplicate dimension IDs,
non-finite numbers, oversized output, and incomplete vectors fail closed.

`unknownWeight` represents request content not covered by the published routing
basis. A configured maximum rejects `model: auto` when unknown weight is too
high. It never silently guesses or falls through to a default model.

## Hard request requirements

Requirements that are visible in the request envelope are derived
programmatically rather than inferred by the semantic classifier:

- endpoint protocol;
- tools;
- image input;
- requested context/output limits.

Models that cannot satisfy hard requirements are excluded before objective
scoring.

## Evidence matrix

The published snapshot contains one complete evidence cell for every configured
candidate model and workload dimension. Each cell identifies its model, dimension, suite digest,
evidence digest, sample count, pass rate, conservative pass-rate lower bound,
failure rate, p95 duration, and pricing coverage.

Unknown measurements remain absent. Unpriced calls are explicit. Unknown cost
is never converted to zero.

Quality aggregation uses the pass-rate lower confidence bound as the
cross-dimension comparable primary value. Average judge score may be retained as
secondary evidence but is not assumed to be calibrated across unrelated
suites.

## Deterministic selection

For a request-decomposition vector `w` and model-by-dimension matrices:

```text
quality     = Q * w
cost        = C * w
latency     = L * w
failureRate = R * w
```

Eligibility precedes ranking. A model is excluded when it is not served, fails
hard requirements, lacks evidence for an active dimension, violates an active-dimension
quality floor, exceeds a failure constraint, or lacks a measurement required by
the selected objective.

Supported objectives:

- `highest-quality`: maximize conservative quality;
- `lowest-cost`: minimize known cost subject to a quality floor;
- `lowest-latency`: minimize p95 latency subject to a quality floor;
- `balanced`: maximize an explicit normalized utility;
- `pareto`: compute the non-dominated frontier and apply an explicit,
  deterministic preference.

Candidate input order never changes the result. Every tie-breaker and fallback
rank is deterministic.

## Published artifact

The routing artifact contains:

- workload-dimension definitions and definition-set digest;
- configured candidate model IDs;
- complete model-by-dimension evidence and aggregate evidence digest;
- publication timestamp.

It contains no prompts, candidate outputs, judge outputs, credentials, account
identifiers, or authoring state.

## Decision provenance

Every automatic decision records:

- requested model `auto`;
- definition-set and evidence digests;
- complete request decomposition and unknown weight;
- derived hard requirements;
- objective and constraints;
- each candidate's computed metrics and exclusion reasons;
- selected model and ordered fallbacks;
- classifier and inference call IDs.

The record must be sufficient to reproduce the deterministic portion of the
decision without retaining the request or any provider response.

## Qualification

Classifier qualification and model qualification are separate.

Classifier fixtures cover single-dimension requests, multi-dimension compositions,
paraphrases, boundary ambiguity, out-of-domain requests, and prompt injection.
Model qualification uses reviewed dimension suites with stable case identities and
enough cases to report confidence bounds. Composition benchmarks verify that the
first-order matrix model predicts observed model ordering. Interaction terms
are not added until measured composite tasks demonstrate a systematic failure.

Production qualification proceeds through deterministic component
qualification, an isolated-token live canary, and fallback/rollback exercises.
