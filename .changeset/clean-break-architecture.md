---
"@velum-labs/routekit": major
"@velum-labs/routekit-accounts": major
"@velum-labs/routekit-cli-core": major
"@velum-labs/routekit-cli-ui": major
"@velum-labs/routekit-config": major
"@velum-labs/routekit-config-core": major
"@velum-labs/routekit-contracts": major
"@velum-labs/routekit-control": major
"@velum-labs/routekit-daemon": major
"@velum-labs/routekit-gateway": major
"@velum-labs/routekit-harness-core": major
"@velum-labs/routekit-registry": major
"@velum-labs/routekit-router": major
"@velum-labs/routekit-runtime": major
"@velum-labs/routekit-telemetry-core": major
"@velum-labs/routekit-testkit": major
"@velum-labs/routekit-tool-claude": major
"@velum-labs/routekit-tool-codex": major
"@velum-labs/routekit-tool-cursor": major
"@velum-labs/routekit-tool-opencode": major
"@velum-labs/routekit-tool-registry": major
"@velum-labs/routekit-tools": major
"@velum-labs/routekit-tracing": major
---

Remove retired compatibility surfaces and introduce explicit resource ownership,
transactional router generations and remote enrollment, and cancellation-safe
harness sessions. Move router configuration ownership into config-core, add
validated provider boundary codecs and streaming, decompose routing and HTTP
endpoints into explicit ports, make daemon/CLI application services declarative,
and enforce intentional package APIs in CI.
