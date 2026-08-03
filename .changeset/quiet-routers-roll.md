---
"@velum-labs/routekit": patch
"@velum-labs/routekit-control": patch
"@velum-labs/routekit-daemon": patch
"@velum-labs/routekit-gateway": patch
"@velum-labs/routekit-runtime": patch
"@velum-labs/routekit-telemetry-core": patch
---

Add zero-downtime daemon worker restarts and upgrades behind a stable cluster
host, including shared listener handoff, rollback-safe generation commits,
worker/host status metadata, managed sidecar ownership, retirement draining,
and rolling lifecycle telemetry.
