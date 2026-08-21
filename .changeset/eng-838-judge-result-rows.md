---
"@velum-labs/routekit": patch
"@velum-labs/routekit-eval-setup": patch
---

Continue generated qualification tests into their judge call after recording a
candidate completion failure, so comparison evidence retains the expected judge
result row. Identify observed qualification calls by role and sequence when the
gateway did not return a model call id.
