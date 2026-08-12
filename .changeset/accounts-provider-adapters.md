---
"@velum-labs/routekit-accounts": patch
---

Move Anthropic and Codex rate-limit parsers out of the shared provider module so each adapter owns its wire translation and shared.ts keeps the port plus generic helpers.
