---
"@velum-labs/routekit": patch
"@velum-labs/routekit-gateway": patch
---

Allow Codex conversations to switch between Claude, chat-based providers, and
native Responses providers without failing on incompatible encrypted reasoning.
RouteKit now preserves opaque reasoning only for its originating provider and
native model while keeping the portable conversation and tool history intact.
