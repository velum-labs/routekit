---
"@velum-labs/routekit": patch
"@velum-labs/routekit-accounts": patch
"@velum-labs/routekit-daemon": patch
"@velum-labs/routekit-gateway": patch
---

Keep credential-load and per-account model-discovery failures visible in daemon
logs while allowing unavailable or empty Codex and Claude subscription catalogs
to coexist with healthy configured providers.
