---
"@velum-labs/routekit": patch
"@velum-labs/routekit-eval-service": patch
---

Compose the eval service directly with the vendored Effect-native eval engine,
removing the parallel comparison-runner wrapper while preserving manifest,
spend-limit, execution, and activation behavior.
