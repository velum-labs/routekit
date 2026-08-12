---
"@velum-labs/routekit": patch
"@velum-labs/routekit-telemetry-core": patch
---

Tie command_completed paths to the CLI command tree so a new command cannot silently miss telemetry and stale allowlist entries cannot linger.
