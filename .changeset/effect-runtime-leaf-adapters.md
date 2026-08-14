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

Migrate RouteKit internals onto Effect with a process-lifetime ManagedRuntime (`RouteKitLive`), tagged failures, FileSystem-backed document persistence, Effect `CapacityPool` leases, HttpClient egress, HttpRouter+NodeHttpServer inbound (drain/SSE/NDJSON wire unchanged), Effect account coordinators, account-set construction/probe/discover/close, subscription providers, proxy client, native Effect `control.v2` handlers (Promise only at the NDJSON wire), Effect reset-credit and auth-recovery programs, CLI catalog/health probes, cliproxy sidecar reachability, control-client health/call/stream as Effect (Promise only at Commander/host/NDJSON iterator edges), remaining CLI install/relay/handshake plus daemon shared-gateway probes as Effect, switching-proxy, endpoint/runtime health probes, ACP registry fetch, gateway web-search execution, OpenRouter metadata, provider HTTP transports, subscription execute/relays, daemon lifecycle/generations/sidecar/host-worker cores, daemon account enroll/remove/rename/sync plus subscription SSE inspect, and subscription usage collection, local usage sources, `startSubscriptionProxy`, router usage, and relay close as Effect (Promise only at Commander/host/stream/bind/generation-persist/ResourceScope edges). Drop wrap-only Effect façades and unused `fetchViaHttpClient`. Schema eval contracts and Effect language-service diagnostics (`globalErrorInEffectFailure` as error; `globalFetch` stays off for tests and the live Fetch adapter, with `globalFetchInEffect` already error). Product wire (control.v2, HTTP/SSE, CLI output, persisted formats) stays unchanged.
