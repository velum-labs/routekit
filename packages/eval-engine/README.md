# `@velum-labs/routekit-eval-engine`

Effect-native evaluation discovery and `node:test` execution extracted from
Ori's standalone eval system.

## Scope

This package is the offline execution foundation:

- recursively discover and list `*.eval.ts` files;
- reject machine-local import specifiers before execution;
- load evals without running test bodies (`dryRunEvals`);
- run evals through a scoped, interruption-safe `node --test` child;
- reconcile Node JUnit cases with Ori-compatible crash-tolerant JSONL agent
  rows, including candidate/judge roles, run keys, unknown/cut-off outcomes,
  scores, durations, tool calls, usage, cost, and optional suite/case/host
  metadata;
- render a shareable Markdown report as a pure value.

It does not start Ori's CLI or daemon and does not invoke the
`ori-eval-system` executable. It does not mutate `process.env`, `argv`, `cwd`,
or stdio. The Node executable and child environment are explicit inputs.

## Effect API

```ts
import {
  makeEvalEngineLayer,
  runEvals
} from "@velum-labs/routekit-eval-engine";
import { Effect, Stream } from "effect";

const program = runEvals({ target: "./evals" }).pipe(
  Stream.runForEach((event) => console.log(event)),
  Effect.provide(
    makeEvalEngineLayer({
      nodeExecutable: "/usr/bin/node",
      environment: { PATH: "/usr/bin" }
    })
  )
);
```

`discoverEvals` and `listEvals` are `Effect` programs. `dryRunEvals` and
`runEvals` are `Stream`s of progress/completion events. Operational failures
are `Data.TaggedError` values in the error channel. Test failures remain typed
run data (`exitCode`, JUnit rows, and agent result rows), rather than becoming
defects.

## Extension boundary

The child receives `ORI_EVAL_RESULTS_FILE`, preserving Ori's append-only JSONL
channel. A later eval-service or authoring SDK can append the exported
`EvalResultLine` shapes without changing this engine. Provider credentials,
gateway construction, candidate/judge model calls, durable history/baselines,
and interactive authoring sessions are deliberately outside this foundational
package.

## Ori provenance

The implementation under `src/ori` is adapted from the Apache-2.0 Ori
standalone eval source at the commit recorded in `ORI_PROVENANCE.json`.
`pnpm provenance:check` verifies the deterministic local source manifest.
