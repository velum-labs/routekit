---
"@velum-labs/routekit-daemon": patch
---

Extract daemon worker spawn and IPC into a HostWorkerSession so the host owns singleton ports and rolls while talking to workers through one typed session.
