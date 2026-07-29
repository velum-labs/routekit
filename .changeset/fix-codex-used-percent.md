---
"@velum-labs/routekit-accounts": patch
"@velum-labs/routekit": patch
---

Treat Codex `used_percent` values as percentages even when the value is `1`, repair ambiguous persisted snapshots, discover the actual Codex response-header families, and surface rejected out-of-range quota observations instead of falsely exhausting healthy subscription accounts.
