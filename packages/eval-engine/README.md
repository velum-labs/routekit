# RouteKit Eval Engine

`@velum-labs/routekit-eval-engine` discovers, validates, and executes RouteKit
Eval suites as an Effect-native library. It contains the complete copied source
distribution used as the migration baseline, while its supported RouteKit entry
point is the package API described here—not a standalone executable or command
protocol.

RouteKit Eval is the offline measurement component of the eval-driven router
MVP:

```text
setup skill
→ routekit/eval suite + routing profile
→ candidate/judge comparison
→ deterministic policy compilation
→ published routing snapshot
→ model: auto + x-routekit-profile
```

The neighboring packages own the other stages:

- `@velum-labs/routekit-eval-setup` provides the durable, one-question-at-a-time
  setup workflow and `setup-eval-routing` skill;
- `@velum-labs/routekit-eval-service` validates approvals and composes an
  injected comparison runner with policy compilation;
- `@velum-labs/routekit-eval-core` compiles comparison evidence into a
  deterministic policy;
- `@velum-labs/routekit-eval-store` publishes compact routing snapshots;
- the RouteKit daemon and router consume those snapshots for profiled
  `model: auto` requests.

Publication remains an explicit action. Running an eval does not silently alter
online routing.

## Public Effect API

### `EvalEngine`

`EvalEngine` is a `Context.Service` with three operations:

- `discover(target)` recursively finds `*.eval.ts` files while applying the
  engine's ignored-directory rules;
- `validate(target)` performs discovery, portable-import validation, and suite
  digest calculation;
- `runComparison(request)` validates explicit candidate and judge model IDs,
  runs the injected execution port, and normalizes real JSONL/JUnit evidence
  into `EvalComparisonResult`.

The package also exports the service accessors `discoverEvals`, `validateEvals`,
and `runEvalComparison`, plus granular tagged errors for discovery, portable
imports, invalid requests, and execution failures.

`makeEvalEngineLayer(execution)` installs an `EvalExecutionPortService`. This
keeps discovery and result normalization independent from the concrete process
adapter and makes tests or later execution implementations injectable.

### Concrete RouteKit execution

`makeRouteKitEvalExecutionPort(options)` constructs the production MVP execution
port. Creating the port is an Effect requiring an injected `HttpClient`; running
a comparison then:

1. starts an ephemeral loopback `RouteKitEvalGatewayBridge`;
2. materializes the generated author SDK as the `routekit/eval` export;
3. starts a scoped `node --test` child for the discovered eval files;
4. forwards candidate and judge calls to the request's OpenAI-compatible
   RouteKit gateway;
5. reads the crash-tolerant result JSONL and JUnit output;
6. closes the child, request fibers, listener, and temporary files with the
   enclosing Effect scope.

`makeNodeTestExecutionPort` is the lower-level adapter for callers that already
own a bridge origin. `makeRouteKitEvalGatewayBridge` and
`makeRouteKitEvalGatewayBridgeLayer` expose the scoped bridge directly when a
host needs to compose its lifecycle separately.

Application code should run the Effect only at its composition boundary:

```ts
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Effect } from "effect";
import {
  makeEvalEngineLayer,
  makeRouteKitEvalExecutionPort,
  runEvalComparison,
} from "@velum-labs/routekit-eval-engine";

const program = Effect.gen(function* () {
  const execution = yield* makeRouteKitEvalExecutionPort({
    bearerCredential: routeKitDataToken,
  });

  return yield* runEvalComparison({
    version: 1,
    profileId: "support",
    suitePath: ".routekit/evals/support",
    candidateModels: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4"],
    judgeModel: "openai/gpt-4.1",
    gatewayUrl: "http://127.0.0.1:8080",
    concurrency: 2,
    timeoutMs: 120_000,
  }).pipe(Effect.provide(makeEvalEngineLayer(execution)));
}).pipe(Effect.provide(NodeHttpClient.layerUndici));
```

The example intentionally does not call `Effect.runPromise` inside the library.
A CLI, daemon, test, or application host owns that final runtime boundary.

## Author SDK and eval files

Eval suites are `node:test` modules. During execution the engine creates a
scoped package exposing only `routekit/eval`; no compatibility module name is
materialized.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { setupAgent, setupJudge } from "routekit/eval";

const judge = setupJudge({
  agent: setupAgent({ model: "openai/gpt-4.1" }),
  minScore: 0.8,
});

test("answers a representative support request", async () => {
  const prompt = "Help the customer recover access without exposing secrets.";
  const run = await setupAgent({ model: "openai/gpt-4.1-mini" }).run(prompt);

  run.toComplete();
  run.toMention("access");
  assert.ok(run.text.length > 0);

  await judge.autoEvals({
    criteria: "The answer is correct, safe, and gives actionable recovery steps.",
    prompt,
    run,
  });
});
```

The generated SDK supports completion, text/emission, tool, cost, and duration
matchers from the copied engine. Matchers write assertion rows using the run
key of the candidate they grade. `setupJudge` sends a separate judge-role call,
requests a structured `{ pass, score, reason }` verdict, and records that
verdict against the candidate outcome. Candidate and judge calls retain
separate roles and result rows.

The `routekit/eval` specifier is an execution-time authoring SDK, not an export
of this npm package. Authors should not replace it with an import from
`@velum-labs/routekit-eval-engine`.

## Gateway configuration and behavior

Every comparison request supplies:

- `gatewayUrl`: the OpenAI-compatible RouteKit inference origin;
- `candidateModels`: one or more explicit `provider/model` IDs;
- `judgeModel`: an explicit `provider/model` ID;
- optional concurrency and timeout controls.

The execution-port factory separately receives the bearer credential. Eval
traffic rejects `auto`, `router`, `default`, duplicate candidate IDs, and model
values without a provider prefix. The parent bridge sends:

```text
Authorization: Bearer <injected credential>
x-routekit-eval-policy-bypass: 1
x-routekit-eval-attribution: { purpose, role, runId, caseId }
```

The bypass header prevents recursive entry into eval-driven automatic routing.
Attribution distinguishes candidate and judge calls. The MVP bridge uses
non-streaming OpenAI Chat Completions, forwards system prompts, temperature and
reasoning effort, and maps author output schemas to OpenAI `json_schema`
response format.

## Result semantics

The concrete executor consumes the engine's append-only JSONL and JUnit output
rather than inventing a parallel result format.

- start, completion, assertion, candidate, and judge rows join through stable
  run keys;
- completed evidence is recoverable when a later test fails or a run is
  interrupted;
- a candidate with no completed terminal row is represented as cutoff;
- a candidate for which no assertion completed remains unknown;
- failed assertions remain failed;
- judge scores are associated with the candidate being graded;
- candidate cost and judge cost remain separate in the underlying rows;
- duration, token, score, and cost measurements remain absent when unreported—
  unknown values are never converted to zero;
- suite and test order provide stable comparison case labels for the current
  normalized result.

`runComparison` returns the compact comparison contract used by policy
compilation. The lower-level `EvalExecutionOutput` retains the complete parsed
result and test rows for reporting or qualification work.

## Lifecycle and interruption

Each comparison owns one independent Effect scope. The scope owns the loopback
listener, in-flight bridge requests, SDK materialization, result and JUnit
files, output drains, and `node --test` child. Interrupting or closing the scope
terminates the child and releases these resources. The RouteKit execution path
does not create a second `ManagedRuntime`, mutate `process.env`, change the
working directory, or invoke a standalone eval executable.

Children receive a minimal explicit environment with the SDK path, bridge
origin, comparison ID, and results path. They do not inherit the parent process
environment. Optional author-visible child variables are supported, but keys
that look like credentials or tokens are rejected before the child starts.

## Security boundary

The bearer credential belongs only to the parent-side bridge:

- it is not placed in child environment variables or arguments;
- it is not included in the bridge handle;
- gateway origins containing credentials, query strings, or fragments are
  rejected;
- upstream response bodies and transport causes are not reflected to the eval
  child;
- bridge errors use generic RouteKit diagnostics;
- published routing snapshots are owned by `eval-store` and exclude prompts,
  raw outputs, credentials, and authoring state.

Callers are responsible for obtaining and scoping the RouteKit data-plane
credential before constructing the execution port. Token issuance is outside
this package.

## MVP capability checklist

Implemented and exercised through the RouteKit library path:

- [x] complete copied source distribution retained inside the package;
- [x] recursive eval discovery and portable-import validation;
- [x] generated `routekit/eval` SDK materialization;
- [x] scoped `node:test` execution without invoking a standalone product;
- [x] real candidate and judge requests through an injected RouteKit gateway;
- [x] explicit-model enforcement and recursive-routing bypass;
- [x] candidate/judge role attribution and structured judge verdicts;
- [x] crash-tolerant JSONL/JUnit parsing, cutoff, unknown, and partial recovery;
- [x] missing measurements remain absent;
- [x] credential isolation and scoped resource cleanup;
- [x] compatibility with the setup skill's generated suite format.

Present in the copied source but not yet exposed as complete RouteKit library
services:

- [ ] the full provider/harness adapter matrix, streaming event vocabulary,
  tool execution, and rich cancellation behavior through the new gateway
  bridge;
- [ ] first-class Effect services for Markdown reports, history, baselines,
  scratch, and the complete durable authoring workflow;
- [ ] enforcement of comparison spend limits by the concrete executor;
- [ ] a production composition adapter from `eval-service`'s comparison runner
  directly to this engine.

## Qualification and current migration debt

The complete copied closure and RouteKit library surface now use RouteKit's
catalog-pinned `effect` and `@effect/platform-node` versions. The workspace
resolves one version of each package, so cross-package Effect services no longer
cross incompatible installations.

The new bridge and child executor avoid a second runtime within one comparison,
but full harness parity has not yet moved behind that path. The immediate
qualification work is to connect `eval-service` to the concrete execution port,
expand the gateway bridge beyond non-streaming chat, and expose reports,
history, and baselines through scoped services.

## Workspace verification

Requires Node 22.22 or newer and the RouteKit pnpm workspace:

```bash
pnpm --filter @velum-labs/routekit-eval-engine typecheck
pnpm --filter @velum-labs/routekit-eval-engine test
pnpm --filter @velum-labs/routekit-eval-engine build
```

Normal tests use local loopback servers and injected clients. They require no
external credentials or external network access.
