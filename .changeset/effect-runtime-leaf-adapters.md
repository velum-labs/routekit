---
"@velum-labs/routekit": patch
"@velum-labs/routekit-accounts": patch
"@velum-labs/routekit-control": patch
"@velum-labs/routekit-daemon": patch
"@velum-labs/routekit-eval-contracts": patch
"@velum-labs/routekit-eval-core": patch
"@velum-labs/routekit-eval-store": patch
"@velum-labs/routekit-gateway": patch
"@velum-labs/routekit-harness-core": patch
"@velum-labs/routekit-router": patch
"@velum-labs/routekit-runtime": patch
"@velum-labs/routekit-telemetry-core": patch
---

Migrate RouteKit internals onto Effect with a process-lifetime ManagedRuntime (`RouteKitLive`), tagged failures, FileSystem-backed document persistence, Effect `CapacityPool` leases, HttpClient egress (Fetch `Response` preserved for streaming), Schema eval contracts, and Effect language-service diagnostics. Product wire (control.v2, HTTP/SSE, CLI output, persisted formats) stays unchanged.
