---
"@velum-labs/routekit-tool-claude": patch
---

Split Claude install wire translation (settings.json and ownership metadata) out of the install/uninstall transaction so a settings-shape change cannot silently drift the recovery protocol.
