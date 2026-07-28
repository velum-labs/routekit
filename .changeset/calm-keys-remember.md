---
"@velum-labs/routekit": patch
"@velum-labs/routekit-daemon": patch
---

Default the leaderboard to the longest available durable window so daemon
restarts no longer make persisted usage appear to be lost.
