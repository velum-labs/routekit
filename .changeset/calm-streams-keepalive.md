---
"@velum-labs/routekit-gateway": patch
"@velum-labs/routekit-runtime": patch
---

Keep native OpenAI Responses SSE relays alive during quiet model phases and emit
a structured terminal error when an upstream stream ends before a Responses
terminal event.
