---
"@velum-labs/routekit-accounts": patch
---

Clear stale subscription quota cooldowns when an authoritative usage snapshot shows the exhausted window has recovered, so a healthy account is no longer held out of the pool until its old cooldown expires. Reconciliation is race-safe (a probe cannot clear a newer cooldown), preserves cooldowns on partial or failed probes and still-exhausted snapshots, works for both Codex and Claude pools, and requires no reset credit or credential refresh. Account diagnostics now expose structured readiness reasons that distinguish credential failure, catalog/model mismatch, quota pressure, and active cooldown.
