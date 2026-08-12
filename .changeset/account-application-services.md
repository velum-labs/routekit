---
"@velum-labs/routekit-daemon": patch
---

Split the account application service into query, enroll, and mutation handler groups so enrollment transactions, inventory reads, and destructive updates cannot silently share one catch-all owner.
