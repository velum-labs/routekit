# Live billed eval-routing testdrive

This qualification drives the current checkout through the complete
eval-routing product journey:

1. a real discovery agent proposes two relevant RouteKit profiles;
2. a real suite-author agent produces grounded, self-contained `routekit/eval`
   cases for each proposal;
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

The harness requires Orbit to advertise `openai/gpt-5.6-luna`,
`openai/gpt-5.6-terra`, and `openai/gpt-5.6-sol`. Both profiles compare all
three models; Luna classifies requests, and Terra authors and judges suites.
The harness never invents a price. If Orbit and RouteKit expose no
authoritative price, the report marks calls unpriced while call and token
failsafes remain active.

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
Missing token usage blocks further billed egress. Missing pricing is recorded
as unpriced instead of being reported as zero-cost.

## Isolation and cleanup

Every run creates a clean detached worktree and fresh temporary state. The
embedded router points only at the metered Orbit egress guard. Effect scopes
own the worktree, listener, router, child processes, and secret files;
interruption and failure run the same finalizers as success.

The discovery agent receives a bounded inventory of the clean detached
RouteKit worktree and proposes profile IDs, descriptions, source files,
authoring briefs, and probe requests. A real bounded suite-author agent reads
those selected sources and returns structured cases. Real candidate, judge,
classifier, and final-inference models perform every remaining semantic stage.
Programmatic checks—not model prose—decide whether protocol, accounting,
publication, and routing passed.

## Evidence

Sanitized evidence is written to:

```text
.artifacts/eval-routing-testdrive/<run-id>/
  events.jsonl
  report.json
```

Structured events and Effect logs carry run, phase, profile, model, call,
duration, reservation, usage, cost, and fixed failure-code fields. The report
contains the tested Git revision, selected models and pricing coverage, stage
transitions, profile/suite/evidence digests, compact published decisions,
classifier scores, selected winners, and the final failsafe ledger.

Artifacts never contain raw prompts, responses, authorization headers, token
values, account identifiers, unsanitized child output, or absolute temporary
paths.

## Passing contract

A passing report proves:

- profile IDs, descriptions, sources, cases, and probes were proposed by real
  agents rather than planted by the harness;
- generated suites are self-contained and import `routekit/eval`;
- each requested candidate and judge produced complete measured rows;
- both canonical profile YAML files and one two-profile snapshot were written;
- eval traffic used explicit models and bypassed automatic routing;
- each `auto` probe emitted exactly one classifier egress and one final egress;
- classifier vectors contain both profiles, are bounded, and sum to one;
- provenance records `requested_model: auto`, the expected profile, evidence
  digest, scores, and selected model; and
- every measured total remained below the generous failsafes.
