# `@velum-labs/routekit-eval-engine`

**RouteKit Eval** is the complete vendored evaluation system, adapted into a
RouteKit workspace library. It exposes Effect services and Layers; it has no
binary, command dispatcher, stdout JSON protocol, owned runtime, or process-exit
boundary.

## Public Effect API

- `EvalEngine` / `EvalRuntime`: recursive discovery, portable-import validation,
  dry-run loading, and scoped `node:test` execution.
- `EvalDiscovery`: recursive `*.eval.ts` cataloguing with ignored directories.
- `EvalHarness`: injected OpenAI-compatible candidate, judge, and author calls.
- `EvalCatalog`: injected and authenticated RouteKit model catalog access.
- `EvalAuthorSdk`: materialization of the generated `routekit/eval` author SDK.
- `EvalReporter`: complete Markdown result, judge, history, and comparison report.
- `EvalHistory`: append-only, crash-tolerant, retained JSONL history.
- `EvalBaseline`: file-scoped last, best, and model baseline comparison.
- `EvalAuthoring`: durable prepare/status/question/answer/complete/stop state with
  one-question-at-a-time typed events.
- `EvalRepository`: RouteKit-owned `.routekit/eval` paths.
- `EvalScratch`: isolated `routekit-eval-scratch-*` workspace creation.

All public operational APIs return `Effect` or `Stream`. Configuration is
explicit: inference/catalog origins, a redacted bearer credential, explicit
candidate/judge/author model IDs, harness, timeout, concurrency, spend limit,
cache/state paths, telemetry, and child environment. Candidate and judge model
IDs reject `auto`, `router`, `default`, and non-provider aliases.

```ts
import {
  EvalHarness,
  makeEvalHarnessLayer
} from "@velum-labs/routekit-eval-engine";
import { Effect, Redacted } from "effect";

const layer = makeEvalHarnessLayer({
  inferenceOrigin: "http://127.0.0.1:8080",
  catalogOrigin: "http://127.0.0.1:8080",
  credential: Redacted.make("injected-token"),
  candidateModel: "openai/gpt-4o-mini",
  judgeModel: "openai/gpt-4o-mini",
  harness: "gateway",
  timeoutMs: 120_000,
  concurrency: 4
});

const program = Effect.gen(function* () {
  const harness = yield* EvalHarness;
  return yield* harness.invoke({
    role: "candidate",
    model: "openai/gpt-4o-mini",
    prompt: "Solve the evaluation case."
  });
});
```

## Generated author SDK

Eval files use the white-labelled module only:

```ts
import { setupAgent, setupJudge } from "routekit/eval";
```

The complete generated SDK and templates are in `assets/sdk`; `EvalAuthorSdk`
materializes them into an isolated workspace. The synchronous matchers preserve
completion, text/emission, tool, cost, duration, sticky-failure, unknown, judge
verdict, score, and minimum-score behavior. They are author-file APIs, not the
Effect library API.

## Result semantics

RouteKit Eval keeps start, completed-run, and assertion lines in append-only
JSONL and joins by run key. A started run with no completion is `cutOff: true`
and `unknown`. A completed run with no assertion is also `unknown`. Failures are
sticky. Missing usage, cost, duration, score, or output measurements remain
absent and reports render them as unmeasured, never as zero. Candidate and judge
roles and costs stay separate.

## Lifecycle and security

Children, temp directories, listeners, and finalizers are scoped. The library
does not mutate `process.env`, `process.argv`, cwd, or stdio. Credentials are
redacted, placed only in authenticated request headers or explicit child
environments, and excluded from errors, reports, telemetry, arguments, and
persisted evidence. Multiple independent service Layers may run concurrently.

## Vendored source inventory and parity checklist

The authored distribution is copied under neutral internal paths. Machine-local
`node_modules`, `dist`, `.build`, package-manager caches, lockfiles, credentials,
runtime state, and test output are excluded.

- [x] 687-file extracted production closure: contracts, engines, adapters,
  runloop, daemon/runtime, providers, harnesses, generated artifacts, and assets
- [x] focused production composition and runtime support source
- [x] recursive discovery, portable imports, dry run, JUnit, JSONL reconciliation
- [x] candidate/judge execution, structured verdicts, role/cost separation
- [x] assertions and all generated author SDK matchers
- [x] Markdown reports, history retention, scoped baselines
- [x] scratch workflow and generated `routekit/eval` SDK
- [x] authoring skills, prompts, durable session state, typed question relay
- [x] standalone production tests and fixtures retained under `test/standalone`
- [x] 25 directly portable standalone contract, gateway-injection, argv, parsing,
  state-copy, and failure-classification tests run in the RouteKit test command
- [x] source/provenance manifest, Apache license, and notices
- [x] branding scan excluding only legal/provenance files

`UPSTREAM_PROVENANCE.json` records the source commits, deterministic adapted-file
hashes, and source-to-vendored mapping. Legal attribution is intentionally
isolated to `LICENSE`, `NOTICE`, and that private provenance manifest.

## Deferred integration

Routing-policy compilation, `model: auto`, online routing enforcement, shadow
replay, online learning, daemon control APIs, scoped eval-token issuance, and
policy publication remain later RouteKit stack layers.

## Qualification boundary

Offline builds and tests require no network or credentials. Paid provider calls,
all native author harness platforms, end-to-end composition of the retained
standalone daemon/CLI-oriented internals through the new library services, and
post-spend interruption recovery still need credential-gated qualification
before a production release. The retained executable-only CLI/source-boundary
tests are provenance fixtures, not a shipped or supported binary surface.
