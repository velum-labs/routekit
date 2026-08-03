---
"@velum-labs/routekit-gateway": patch
---

Keep OpenRouter metadata deadlines alive until pending requests settle so
timeouts reliably reject instead of leaving unresolved model selection work.
