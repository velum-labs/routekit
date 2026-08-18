# `@velum-labs/routekit-eval-service`

Offline Effect composition for RouteKit Eval: validate reviewed dimension
suites, estimate and run an approved comparison through an injected runner,
compile a complete model-by-dimension evidence matrix, and publish a compact
routing activation.

The package deliberately does not import the online gateway, router, daemon, or
CLI. `makeRouteKitEvalSetupLayer` is the production library composition used by
the CLI. It connects the durable `EvalSetup` workflow to the complete vendored
eval engine, scoped `node:test` execution, an injected OpenAI-compatible
RouteKit gateway, deterministic policy compilation, and the routing snapshot
store.

Credentials are required only for paid model execution. Normal CLI runs acquire
a scoped eval session from the configured local or remote RouteKit target.
Explicit external gateways may qualify evidence but cannot publish an
activation. Credentials stay in the parent gateway bridge and are not added to
child arguments, child environments, evidence, or published artifacts.
