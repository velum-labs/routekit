---
"@velum-labs/routekit": patch
"@velum-labs/routekit-eval-service": patch
---

Run qualification node:test children from an isolated suite copy so project-local
`routekit/eval` or `ori/eval` packages cannot restore a shorter hidden execution
deadline ahead of the named qualification timeout.
