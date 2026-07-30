---
"@velum-labs/routekit": minor
"@velum-labs/routekit-tool-claude": minor
"@velum-labs/routekit-tool-codex": minor
---

Add metadata-only session management for RouteKit-launched Claude Code and Codex
sessions, including exact resume and deterministic continue. Claude removal is
forget-only; Codex uses its supported exact native delete command before removing
RouteKit metadata.
