---
"@velum-labs/routekit-accounts": patch
"@velum-labs/routekit-gateway": patch
---

Retry managed Codex subscription requests when forced upstream SSE reports a terminal quota failure before output, while preserving structured stream errors and holding account capacity through body completion.
