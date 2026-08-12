---
"@velum-labs/routekit-gateway": patch
---

Split Anthropic Messages request/response/stream translation out of the provider backend so wire changes do not drag HTTP transport with them.
