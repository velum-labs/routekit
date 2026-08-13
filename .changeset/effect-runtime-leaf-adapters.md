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

Migrate RouteKit internals onto Effect with a process-lifetime ManagedRuntime (`RouteKitLive`), tagged failures, FileSystem-backed document persistence, Effect `CapacityPool` leases, HttpClient egress, HttpRouter+NodeHttpServer inbound (drain/SSE/NDJSON wire unchanged), Effect account coordinators, account-set construction, subscription providers, proxy client, native Effect `control.v2` handlers (Promise only at the NDJSON wire), Effect reset-credit and auth-recovery programs, CLI catalog/health probes, cliproxy sidecar reachability, control-client health/call as Effect (Promise only at Commander/host/stream edges), and remaining CLI install/relay/handshake plus daemon shared-gateway probes as Effect, Schema eval contracts, and Effect language-service diagnostics. Product wire (control.v2, HTTP/SSE, CLI output, persisted formats) stays unchanged.
