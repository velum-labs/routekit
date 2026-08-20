---
"@velum-labs/routekit": patch
"@velum-labs/routekit-control": patch
"@velum-labs/routekit-daemon": patch
"@velum-labs/routekit-eval-setup": patch
"@velum-labs/routekit-gateway": patch
---

Fix ENG-834 by increasing evaluation-authoring output headroom for twenty-case
suites and reporting max-token Responses truncation as an incomplete, failed
model call with its stop reason instead of an invalid-JSON authoring response.
