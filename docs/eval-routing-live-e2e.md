# Live billed eval-routing testdrive

This qualification drives the current checkout through the complete
eval-routing product journey:

1. a real discovery agent proposes two relevant RouteKit profiles, followed by
   two real setup interviews;
2. real author-agent turns and generated `routekit/eval` suites;
3. real candidate and judge calls through an embedded RouteKit router SDK;
4. publication of two measured routing profiles; and
5. real classifier-driven `model: auto` requests with no profile header.

It uses no provider simulator, mocked service, fake Layer, canned provider
response, planted snapshot, or global RouteKit product command.

## Authorization

Live execution is manual and disabled by default. Build and run:

```bash
export ROUTEKIT_LIVE_E2E=1

pnpm test:e2e:eval-routing:live -- \
  --live \
  --orbit-url https://orbit-gateway.velum.sh \
  --orbit-token-file /private/path/orbit-e2e-token
```

The token is held only by the parent Effect runtime and the local egress guard.
It is not forwarded in child argv, environment, logs, reports, or generated
eval artifacts. Eval authoring and setup are driven through their Effect APIs,
not by constructing RouteKit CLI argument arrays.

The harness selects disjoint candidate slates, an author, a judge, and a
classifier from Orbit's discovered `openai/*` catalog. Every selected model
must resolve through RouteKit's checked-in pricing registry. The harness does
not invent a price for an unknown model.

## Runaway failsafes

The limits are circuit breakers, not a target budget:

- 512 billed egress calls;
- 5,000,000 input tokens;
- 1,000,000 output tokens;
- $100 registry-estimated spend;
- 16,384 output tokens for one call; and
- two hours wall time.

Override them only by setting the corresponding `ROUTEKIT_EVAL_E2E_MAX_*`
environment variable. The egress guard atomically reserves a conservative
maximum before a request and reconciles complete JSON/SSE usage afterward.
Missing usage or pricing blocks further billed egress.

## Isolation and cleanup

Every run creates a clean detached worktree and fresh temporary state. The
embedded router points only at the metered Orbit egress guard. Effect scopes
own the worktree, listener, router, child processes, and secret files;
interruption and failure run the same finalizers as success.

The discovery agent receives a bounded inventory of the clean detached
RouteKit worktree and proposes profile IDs, descriptions, authoring briefs, and
probe requests. A real bounded operator agent then answers one setup question
at a time from each proposed brief. Real author, candidate, judge, classifier,
and final-inference models perform every semantic stage. Programmatic
checks—not model prose—decide whether protocol, accounting, publication, and
routing passed.

## Evidence

Sanitized evidence is written to:

```text
.artifacts/eval-routing-testdrive/<run-id>/
  events.jsonl
  report.json
```

Structured events and Effect logs carry run, phase, profile, model, call,
duration, reservation, usage, cost, and fixed failure-code fields. The report
contains the tested Git revision, selected pricing-backed models, stage
transitions, profile/suite/evidence digests, compact published decisions,
classifier scores, selected winners, and the final failsafe ledger.

Artifacts never contain raw prompts, responses, authorization headers, token
values, account identifiers, unsanitized child output, or absolute temporary
paths.

## Passing contract

A passing report proves:

- both interviews progressed through the public `EvalSetup` Effect service and
  persisted durable checkpoints;
- generated suites are self-contained and import `routekit/eval`;
- each requested candidate and judge produced complete measured rows;
- both canonical profile YAML files and one two-profile snapshot were written;
- eval traffic used explicit models and bypassed automatic routing;
- each `auto` probe emitted exactly one classifier egress and one final egress;
- classifier vectors contain both profiles, are bounded, and sum to one;
- provenance records `requested_model: auto`, the expected profile, evidence
  digest, scores, and selected model; and
- every measured total remained below the generous failsafes.
