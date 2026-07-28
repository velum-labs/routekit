---
"@velum-labs/routekit": patch
"@velum-labs/routekit-contracts": patch
"@velum-labs/routekit-gateway": patch
"@velum-labs/routekit-tool-claude": patch
"@velum-labs/routekit-tool-cursor": patch
"@velum-labs/routekit-tool-codex": patch
"@velum-labs/routekit-tool-opencode": patch
---

Add shared reasoning-effort model variants for Claude Code and Cursor, and
route validated `--effort` selections through every current launcher.

Claude Code discovery now advertises `<base>:<effort>` picker entries from
provider-discovered capabilities, normalizes them to the unsuffixed base model,
and applies request-scoped adaptive thinking plus `output_config.effort` on
both native relay and translated routes. Unsupported qualified ids fail before
any provider call. Direct `routekit claude --effort` and `routekit cursor
--effort` no longer drop a validated selection.
