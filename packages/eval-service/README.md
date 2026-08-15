# `@velum-labs/routekit-eval-service`

Offline Effect composition for RouteKit Eval's MVP loop: validate a generated
suite, estimate and run an approved comparison through an injected runner,
compile deterministic routing evidence, and publish the compact routing
snapshot.

The package deliberately does not import the online gateway, router, daemon, or
CLI. The comparison port is injected so the copied eval engine can be adapted
at a single boundary while its Effect version is migrated.
