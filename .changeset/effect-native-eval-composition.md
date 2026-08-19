---
"@velum-labs/routekit": patch
"@velum-labs/routekit-eval-service": patch
---

Make Effect the RouteKit application runtime: live layers now acquire daemon,
gateway, telemetry, token, eval-session, and eval execution lifetimes instead
of succeeding prebuilt coordinator bags. The daemon worker owns one
ManagedRuntime, the cluster primary is an Effect supervision tree with
Ref-owned generation publication, and standalone gateway façades dispose their
own runtimes.

Compose eval-service directly with the native EvalEngine and a streaming,
interruptible Ori execution port. Keep vendored sources untouched, prevent
application packages from launching a second Ori host, and preserve existing
control.v2, HTTP/SSE, CLI, persisted, and published package contracts.
