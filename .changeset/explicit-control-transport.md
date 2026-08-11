---
"@velum-labs/routekit": major
"@velum-labs/routekit-config-core": major
"@velum-labs/routekit-runtime": major
---

Make control clients depend on an explicit control transport, including a
native SSH relay transport instead of adapting SSH through a synthetic
`fetch`. Keep configuration-core limited to schemas and policy by removing its
Node filesystem/runtime dependency.
