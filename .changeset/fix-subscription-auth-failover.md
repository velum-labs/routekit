---
"@velum-labs/routekit-accounts": patch
"@velum-labs/routekit-contracts": patch
"@velum-labs/routekit-gateway": patch
"@velum-labs/routekit": patch
---

Add a persisted credential-authentication state machine for managed
subscriptions. Coalesce refresh and probation, reroute pre-commit failures to
healthy accounts, distinguish credential-, model-, and request-scoped denials,
surface upstream authentication readiness, and map permanent rejection versus
temporary recovery to actionable gateway errors.
