---
"@velum-labs/routekit-gateway": patch
---

Fix ENG-737 by emitting OpenAI-compatible `tsc_` item IDs for translated
`tool_search_call` responses so their history remains valid after a model switch.
