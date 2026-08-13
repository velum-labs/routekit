---
"@velum-labs/routekit-config-core": patch
"@velum-labs/routekit-gateway": patch
---

Move configuredProviderIds onto config-core so the gateway catalog and the config package cannot disagree about which providers are enabled or in what order.
