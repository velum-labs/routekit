---
"@velum-labs/routekit": patch
"@velum-labs/routekit-gateway": patch
"@velum-labs/routekit-tool-claude": patch
---

Use Claude Code's native custom-model picker and effort selector instead of
advertising synthetic `claude-*` and effort-qualified RouteKit models. Claude
can now route an unambiguous bare provider-native model id.
