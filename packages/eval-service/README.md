# `@velum-labs/routekit-eval-service`

Offline Effect composition for RouteKit Eval: validate reviewed dimension
suites, estimate and run an approved comparison through the native eval-engine
service,
compile a complete model-by-dimension evidence matrix, and publish a compact
routing activation.

The package deliberately does not import the online gateway, router, daemon, or
CLI. `makeRouteKitEvalServiceLayer` composes `EvalService` directly with the
vendored engine's `EvalEngine` layer and its scoped execution port. There is no
parallel comparison-runner service or mirrored engine API.

Credentials are required only for paid model execution. Normal CLI runs acquire
a scoped eval session from the configured local or remote RouteKit target.
Explicit external gateways may qualify evidence but cannot publish an
activation. Credentials stay in the parent gateway bridge and are not added to
child arguments, child environments, evidence, or published artifacts.
