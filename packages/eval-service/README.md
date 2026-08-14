# `@velum-labs/routekit-eval-service`

Effect-native application layer for RouteKit evaluations. It is the sole
production owner of `@velum-labs/routekit-eval-engine`.

The service discovers, lists, dry-runs, and runs `*.eval.ts` paths. Completed
engine summaries are attached to a versioned run manifest, normalized into
candidate/judge observations, and atomically stored under
`<repository>/runs/<run-id>/`. Run directories are immutable. Directories use
mode `0700` and evidence files use `0600`.

Repository run IDs are validated before path construction. Native runs use
`eval_<16 lowercase hex>`; deliberately imported evidence must use the
`import_<safe-slug>` namespace. Path separators, dot segments, and arbitrary
legacy identifiers are rejected with `InvalidEvalRunIdError`.

## Authoring subset

Each execution materializes a scoped module loader for `ori/eval`; it does not
install or launch Ori. Both `node:test` and `bun:test` imports are accepted.
The supported author contract is:

- `setupAgent({ model?, suiteId?, caseId? }).run(prompt, { caseId? })`
- run assertions: `tool(name).toBeCalled()`, `toNotBeCalled()`,
  `toComplete()`, `toMention()`, `toCostAtMost()`, and `toFinishWithin()`
- `setupJudge({ model?, minScore? }).autoEvals({ criteria, run })`
- `startingCriteria`

Candidate and judge calls use the configured OpenAI-compatible RouteKit
gateway with explicit model IDs. The generated adapter appends the engine's
crash-tolerant result protocol automatically. Unsupported Ori catalog,
baseline, and custom-harness APIs are intentionally left for a later adapter;
the scoped loader is the extension seam.

The service is configured through an Effect `Layer`, including the temporary
gateway URL/token boundary. Token lifecycle management is owned by the next
stack layer.
