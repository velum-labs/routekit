---
"@velum-labs/routekit": patch
---

Make persistent Codex and Claude installs store dedicated gateway credentials in
the OS Keychain or a private RouteKit secret file. Codex and Claude now retrieve
their credentials on demand through native credential helpers, so terminal,
IDE, and GUI launches work without copying tokens into shell startup files.
Native install records now carry an install-contract version and RouteKit
provenance so legacy records can be migrated safely as integrations evolve.
