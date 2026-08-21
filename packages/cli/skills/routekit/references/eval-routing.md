# Set Up Eval Routing

Use the public `routekit eval` CLI as the product boundary. Do not substitute
internal services, a standalone eval executable, or testkit qualification
commands for missing CLI functionality.

Inside the RouteKit source checkout, build first and use:

```text
node packages/cli/dist/index.js
```

For an installed release, use `routekit`. `$ROUTEKIT` denotes the resolved
`routekitArgv` from `SKILL.md`; do not use it as a shell variable or pass the
literal token.

## Resolve eval parameters

Enter this workflow only after the required Resolution gate in `SKILL.md` has
recorded `health = ready`. Reuse its exact `repositoryRoot` and `targetArgs`;
do not repeat target selection or inherit the active remote here.

Before advancing the project, resolve:

- `candidateModels`, `classifierModel`, `authorModel`, and `judgeModel`: exact
  `provider/model` IDs selected through the setup workflow;
- `evalScope`: `pilot` or `full`;
- `planId` and `runId`: identifiers returned by the CLI, never reconstructed;
  and
- `spendApproved` and `publishApproved`: separate explicit user decisions.

Record the source of every resolved value. Keep candidate models as an ordered,
deduplicated argv list. Treat `planId` and `runId` as opaque strings. Treat
approvals as false unless the user explicitly grants the corresponding action
for the current repository, target, artifact digest, scope, and plan.

Do not carry model IDs, targets, plan IDs, run IDs, or approvals from another
repository or eval project. Never execute a command with an unresolved
placeholder.

## Discover the available interface

Run `$ROUTEKIT eval --help` and the relevant subcommand help before acting. Use
only commands and flags exposed by that CLI version. Prefer `--json` for state,
plans, estimates, and results.

Apply the resolved global target arguments consistently to model-backed
authoring and execution commands. The optional `--repository` argument must
resolve to `repositoryRoot` when commands are run outside that root.

Do not ask for a gateway URL or credential when that configured target works.
An explicitly supported external gateway mode may use `--gateway-url` and one
private credential source, but it is for qualification only and must never
publish a routing activation.

## Resume or initialize

1. Run
   `[...routekitArgv, ...targetArgs, "eval", "status", "--json"]` from the
   repository root.
2. If no eval project exists, run
   `[...routekitArgv, ...targetArgs, "eval", "setup", "--json"]`.
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
new digest rather than reusing an old approval. Digest approval proves which
artifact was reviewed; it does not prove that the routing basis is orthogonal,
unsmeared, or suitable for launch.

Use the following as prompt and manual-review guidance, not as a pipeline
guarantee. Ask for a routing basis with 5–10 orthogonal workload dimensions.
Ask each definition to include positive scope, exclusions, and a contrast
pair: one request that should receive majority weight on the dimension and one
same-workload near-miss that should route to a sibling dimension or unknown.
Treat request-envelope capabilities such as tools, vision, context, and
maximum output as hard requirements rather than semantic workload dimensions.

During manual review, send the proposal back for revision when:

- any dimension lacks an exclusive in-scope request or a distinct near-miss;
- product-behavior axes are mixed with repository-change/process axes; or
- a dimension is an implementation, tests/docs/CI/release, eval/classifier, or
  other always-on layer that would receive high weight on almost every ticket.

The current approval step can still bind the digest of a semantically smeared
basis. Do not describe these review heuristics as validation enforced by
`eval approve dimensions`, and do not treat dimension approval alone as launch
evidence.

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

Treat a local run that reports zero model or gateway calls as pipeline
bring-up, not qualification. A zero-call run is not launch evidence even when
the command exits successfully, validation passes, and artifact digests were
approved. Stop before publication, report the missing execution evidence, and
do not claim `model: auto` is qualified.

Run `eval publish` only when all of these are true:

- dimensions and evaluations were approved at their current digests;
- validation passed and the immutable plan is still fresh;
- the run observed the planned nonzero model and gateway calls;
- every configured candidate has exactly one judged result for every expected
  case in every dimension;
- the decomposition and composition benchmarks passed;
- the run has zero active reservations and zero unknown measurements;
- the user reviewed the results and explicitly approved activation; and
- the run used a configured local or remote RouteKit target, not an external
  gateway.

Publication installs already-measured evidence atomically; it must not perform
another billed run. After publication, check `eval status`, then verify an
ordinary headerless `model: auto` request. Use
`$ROUTEKIT calls inspect <call-id>` to inspect sanitized routing provenance
when needed.

## Safety

- Never spend or publish silently.
- Never send repository material before approval for the model-backed step.
- Never log, echo, or commit credentials.
- Never describe unknown cost as zero.
- Never publish incomplete, stale, mismatched, duplicated, or cutoff evidence.
- Never publish or claim launch readiness from a zero-call run.
- Never claim that a passing pilot or classifier-only run is production routing
  qualification.
