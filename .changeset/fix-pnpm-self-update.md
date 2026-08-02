---
"@velum-labs/routekit": patch
---

Fix ENG-734 by recognizing pnpm 11 hashed global installs during self-update
ownership detection and verifying updates when pnpm moves the package to a new
store-backed project path.
