# `@velum-labs/routekit-eval-service`

Offline Effect composition for RouteKit Eval's MVP loop: validate a generated
suite, estimate and run an approved comparison through an injected runner,
compile deterministic routing evidence, and publish the compact routing
snapshot.

The package deliberately does not import the online gateway, router, daemon, or
CLI. `makeRouteKitEvalSetupLayer` is the production library composition used by
the CLI. It connects the durable `EvalSetup` workflow to the complete vendored
eval engine, scoped `node:test` execution, an injected OpenAI-compatible
RouteKit gateway, deterministic policy compilation, and the routing snapshot
store.

The bearer credential is optional while preparing, validating, or estimating
and required only for paid comparison execution. The snapshot root is explicit;
the RouteKit CLI supplies `$ROUTEKIT_HOME/eval`, producing
`published-routing.v1.json`. Credentials stay in the parent gateway bridge and
are not added to child arguments, child environment, evidence, or snapshots.
