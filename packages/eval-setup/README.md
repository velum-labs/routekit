# @velum-labs/routekit-eval-setup

Effect-native, interruption-safe onboarding primitives for RouteKit eval-driven
routing.

This MVP package provides:

- a durable one-question-at-a-time setup state machine;
- bounded repository inspection for model surfaces and authoring material,
  including traversal, file-count, file-size, and total-byte limits;
- transparent `routekit/eval` suite and routing-profile scaffolding;
- exactly two explicit candidate models plus a distinct explicit judge, and
  three transparent seed cases authors can replace with real inputs;
- explicit pilot/full-run and publication approval gates;
- an injected `EvalSetupRunner` port for validation, estimation, execution,
  policy proposal, and publication;
- the `setup-eval-routing` coding-agent skill.

The package does not yet supply the production runner adapter. Until a later
composition layer connects `EvalSetupRunner` to eval-engine, policy compilation,
and snapshot storage, it cannot execute or publish a real comparison by itself.
It does not invoke an executable, own a second runtime, or send model traffic.
