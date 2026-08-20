---
name: setup-eval-routing
description: >-
  Onboard or maintain a repository's compositional RouteKit eval routing through
  the public routekit eval CLI. Use when the user wants to define a routing
  basis, review workload dimensions, author or approve evaluations, validate or
  estimate a billed plan, run model evidence, inspect results, activate
  model:auto routing, or resume an interrupted eval project.
---

# Set Up Eval Routing

Use the public `routekit eval` CLI as the product boundary. Do not substitute
internal services, a standalone eval executable, or testkit qualification
commands for missing CLI functionality.

Inside the RouteKit source checkout, build first and use:

```text
node packages/cli/dist/index.js
```

For an installed release, use `routekit`. Refer to either form as `$ROUTEKIT`.

## Discover the available interface

Run `$ROUTEKIT eval --help` and the relevant subcommand help before acting. Use
only commands and flags exposed by that CLI version. Prefer `--json` for state,
plans, estimates, and results.

Normal model-backed commands use RouteKit's standard target resolution:

1. an explicit global `--remote <name>` or `--local` selection;
2. the active remote, when configured; otherwise
3. the local daemon.

Do not ask for a gateway URL or credential when that configured target works.
An explicitly supported external gateway mode may use `--gateway-url` and one
private credential source, but it is for qualification only and must never
publish a routing activation.

## Resume or initialize

1. Run `$ROUTEKIT --json eval status` from the repository root.
2. If no eval project exists, run `$ROUTEKIT --json eval setup`.
3. Follow `nextAction` and the returned artifact paths. Durable state lives
   under `.routekit/evals`; resume it rather than starting over after an
   interruption.
4. When setup returns a question, relay exactly that question and its context.
   Ask one question per turn and never answer it for the user.
5. Submit the answer unchanged with `eval answer`. Prefer a private temporary
   answer file for multiline text when the CLI supports one, then remove it.

Candidate, classifier, author, and judge roles must use explicit
`provider/model` IDs. Eval traffic must never use `model: auto`.

## Build and review the routing basis

Use the CLI workflow in this order, following the current `nextAction`:

1. `eval propose dimensions`
2. review the generated routing basis and every workload dimension;
3. `eval approve dimensions`
4. `eval propose evaluations`
5. review every dimension suite, case identity, rubric, manifest, and source
   boundary;
6. `eval approve evaluations`
7. `eval validate`

Treat proposals as review material, not activation evidence. Approval is bound
to the exact artifact digest. If an artifact changes, validate and approve the
new digest rather than reusing an old approval.

A useful routing basis normally contains 5–10 orthogonal workload dimensions.
Each definition must include positive scope, exclusions, and a contrast pair:
one request that should receive majority weight on the dimension and one
same-workload near-miss that should route to a sibling dimension or unknown.
Request-envelope capabilities such as tools, vision, context, and maximum
output are hard requirements, not semantic workload dimensions.

Reject the proposal instead of approving its digest when:

- any dimension lacks an exclusive in-scope request or a distinct near-miss;
- product-behavior axes are mixed with repository-change/process axes; or
- a dimension is an implementation, tests/docs/CI/release, eval/classifier, or
  other always-on layer that would receive high weight on almost every ticket.

Unknown weight absorbs the remainder. Do not add catch-all axes to cover it.
For a gateway product basis, protocol, selection, classification, and quota can
share one classifier; repository operations belong in a second classifier or
in tags, not in the same summed vector.

Keep generated evaluations and sanitized structured results reviewable in the
repository when the user approves committing them. Do not hand-edit immutable
plans or measured run records.

## Preserve the classifier boundary

The decomposition classifier receives only:

- the request; and
- the reviewed workload-dimension definitions.

It emits one weight per dimension plus an unknown weight, normalized to sum to
one. It must not receive candidate models, evidence, prices, objectives,
selected models, fallbacks, or previous routing decisions.

Model selection is deterministic. It combines the request decomposition, hard
requirements, the approved objective and constraints, and the published
model-by-dimension evidence matrix.

## Estimate and run

Before every billed step:

1. explain what will call models and show the resolved target and explicit model
   roles;
2. run `eval estimate` for the intended scope;
3. report exact call and token limits and the CLI's pricing status—missing
   pricing is unknown, never zero; and
4. obtain explicit user approval for that plan.

Run the immutable plan with `eval run` using the plan identifier returned by
the CLI. Do not silently reduce case counts, change candidates, replace failed
rows, or retry a completed paid plan. After an interruption or ambiguous
result, use `eval status` and `eval results` before deciding whether work
remains.

Never expose credentials, prompts, responses, headers, or raw child output.
Never recursively evaluate through `model: auto`.

## Review results and activate

Use `eval results` to review the decomposition benchmark, every dimension
suite, the composition benchmark, the complete evidence matrix, accounting,
and cleanup outcome.

Run `eval publish` only when all of these are true:

- dimensions and evaluations were approved at their current digests;
- validation passed and the immutable plan is still fresh;
- every configured candidate has exactly one judged result for every expected
  case in every dimension;
- the decomposition and composition benchmarks passed;
- the run has zero active reservations and zero unknown measurements;
- the user reviewed the results and explicitly approved activation; and
- the run used a configured local or remote RouteKit target, not an external
  gateway.

Publication installs already-measured evidence atomically; it must not perform
another billed run. After publication, check `eval status`, then verify an
ordinary headerless `model: auto` request. Use `routekit calls inspect <call-id>`
to inspect sanitized routing provenance when needed.

## Safety

- Never spend or publish silently.
- Never send repository material before approval for the model-backed step.
- Never log, echo, or commit credentials.
- Never describe unknown cost as zero.
- Never publish incomplete, stale, mismatched, duplicated, or cutoff evidence.
- Never claim that a passing pilot or classifier-only run is production routing
  qualification.
