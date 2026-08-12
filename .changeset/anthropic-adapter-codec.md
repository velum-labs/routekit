---
"@velum-labs/routekit-gateway": patch
---

Split the Anthropic Messages adapter into wire types, JSON/SSE codecs, Claude picker policy, and HTTP handlers so translation can change without dragging the server path with it.
